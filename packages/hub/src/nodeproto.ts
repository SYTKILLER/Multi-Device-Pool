/**
 * 节点协议端点（01 §1.1 /node）：TCP + 换行分隔 JSON 控制帧（P0 同机/局域网形态；
 * v1 跨机时本层外套 TLS1.3 + root 签名证书，帧协议不变，01 §5.1）。
 * 职责：hello 验签入册、dispatch（带超时）、心跳 RTT、断线对账（reconcile）。
 */
import net from 'node:net';
import { createHash, verify as cryptoVerify, createPublicKey, type KeyObject } from 'node:crypto';
import type { NodeManifest, OverlayConfig, ResultEnvelope, JournalVerdictDetail, AuditRecord } from '@mdp/contract';
import { WireDecoder, encodeBinFrame } from '@mdp/contract';
import { saveHubDb, type HubDbShape } from './state.js';

const canonicalJson = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',') + '}';
};

export interface NodeHandle {
  node_id: string;
  manifest: NodeManifest;
  rtt_ms: number | null;
  last_heartbeat: number;
}

export interface PendingCall {
  call_id: string;
  node_id: string;
  kind: string;
  params: Record<string, unknown>;
  resolve: (env: ResultEnvelope) => void;
  timer: NodeJS.Timeout;
  sentAt: number;
}

/** bin 流汇（P2-1）：节点流上来的块按 stream=call_id 路由到 transfer 编排器 */
export interface BinSink {
  onChunk: (seq: number, payload: Buffer) => void;
  /** 节点侧流中断（bin_abort/断连） */
  onAbort?: (reason: string) => void;
}

export interface NodeServerOptions {
  port: number;
  home: string;
  db: HubDbShape;
  onLog: (line: string) => void;
  /** dispatch 等待节点回复的上限（node 侧有更短超时，此处是兜底） */
  defaultCallDeadlineMs?: number;
  onNodeOffline?: (nodeId: string) => void;
  /** 断线重连对账后回调（hub 决定透明重发/判死） */
  onReconciled?: (nodeId: string, verdicts: JournalVerdictDetail[]) => void;
  /** 审批续跑的结果回注：call_result 不在 pending（原调用已应答 needs_approval）但带 job_id */
  onJobResult?: (jobId: string, env: ResultEnvelope) => void;
  /** hello 时取该节点 overlay 随 welcome 下发（P1-1：hub 是 overlay 唯一事实源） */
  getOverlay?: (nodeId: string) => OverlayConfig | undefined;
  /** P1-5：audit_pull 的应答回注 */
  onAuditRecords?: (nodeId: string, records: AuditRecord[], lastSeq: number) => void;
}

export class NodeProtocolServer {
  readonly nodes = new Map<string, Conn>(); // node_id → conn
  readonly pending = new Map<string, PendingCall>();
  /** P2-1：stream（=call_id）→ bin 汇。dispatch(binSink) 注册，编排器消费 */
  readonly binSinks = new Map<string, BinSink>();
  private server: net.Server;
  private heartbeatTimer?: NodeJS.Timeout;
  readonly heartbeatMs: number;
  /** 已见过的节点公钥（node_id → KeyObject），避免每次 hello 重复解析 */
  readonly pubkeys = new Map<string, KeyObject>();

  constructor(public readonly opts: NodeServerOptions) {
    this.heartbeatMs = Number(process.env['MDP_HEARTBEAT_MS'] ?? 10000); // 01 §5.1：应用层带 RTT ping
    this.server = net.createServer((sock) => new Conn(sock, this));
    this.server.listen(opts.port);
  }

  get port(): number {
    const addr = this.server.address();
    return typeof addr === 'object' && addr ? addr.port : this.opts.port;
  }

  /** 按 display_name 或 node_id 找节点（工具参数 node 二者皆可） */
  byName(name: string): NodeHandle | undefined {
    for (const [id, conn] of this.nodes) {
      if (!conn.manifest) continue;
      if (id === name || conn.manifest.display_name === name) return conn.handle();
    }
    return undefined;
  }

  listHandles(): NodeHandle[] {
    return [...this.nodes.values()].map((c) => c.handle());
  }

  isOnline(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  /** 派发一次调用；离线立即 offline 信封，回复超时按 network/unknown 处理 */
  dispatch(nodeId: string, kind: string, params: Record<string, unknown>, deadlineMs: number): Promise<ResultEnvelope> {
    return this.dispatchEx(nodeId, kind, params, deadlineMs).promise;
  }

  /**
   * P2-1：派发 + 暴露 call_id（transfer 编排要在 call 行写出后立刻向同一连接流 bin 帧）
   * + 可选 binSink（节点回流出块的流注册，先于 call 行——无竞态）。
   * call 行在本调用内同步写出（Promise executor 同步段），随后即可 sendBin。
   */
  dispatchEx(nodeId: string, kind: string, params: Record<string, unknown>, deadlineMs: number, binSink?: BinSink): { promise: Promise<ResultEnvelope>; callId: string } {
    const conn = this.nodes.get(nodeId);
    const ts = Date.now();
    if (!conn) {
      const handle = this.opts.db.nodes[nodeId];
      return {
        promise: Promise.resolve({
          status: 'failed', node_id: nodeId, call_id: '', ts_hub: ts,
          error: { class: 'offline', retryable: false, message: `节点 ${nodeId} 离线（最后心跳 ${handle ? handle.last_seen : '从未上线'}）` },
        }),
        callId: '',
      };
    }
    const callId = conn.allocCallId();
    if (binSink) this.binSinks.set(callId, binSink);
    const promise = new Promise<ResultEnvelope>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        this.binSinks.delete(callId);
        resolve({
          status: 'unknown', node_id: nodeId, call_id: callId, ts_hub: Date.now(),
          error: {
            class: 'network', retryable: false,
            message: `等待节点回复超时（${deadlineMs}ms）。journal 已记录 started 的调用不得盲目重发：先对账确认是否已发生（job_output / 节点侧 journal）`,
          },
        });
      }, deadlineMs);
      const pending: PendingCall = { call_id: callId, node_id: nodeId, kind, params, resolve, timer, sentAt: Date.now() };
      this.pending.set(callId, pending);
      conn.send({ t: 'call', call_id: callId, kind, params });
    });
    return { promise, callId };
  }

  /** P2-1：向节点连接流一个 bin 帧（背压：write false 时等 drain） */
  async sendBin(nodeId: string, stream: string, seq: number, payload: Buffer): Promise<void> {
    const conn = this.nodes.get(nodeId);
    if (!conn) throw new Error(`节点 ${nodeId} 离线，bin 帧发送中止`);
    await conn.sendBin({ stream, seq, bytes: payload.length }, payload);
  }

  /** overlay 即时推送（01 §3.2：hub 下发 → 节点即时生效；在跑 job 跑完为止） */
  pushOverlay(nodeId: string, overlay: OverlayConfig): boolean {
    const conn = this.nodes.get(nodeId);
    if (!conn) return false;
    conn.send({ t: 'overlay', overlay });
    return true;
  }

  /** 断线重连后的对账入口（01 §4.3：hub 重连节点先对账，再决定续报/判死） */
  reconcile(nodeId: string, conn: Conn): void {
    const ids = [...this.pending.values()].filter((p) => p.node_id === nodeId).map((p) => p.call_id);
    if (ids.length === 0) return;
    conn.send({ t: 'reconcile', ids });
  }

  startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const conn of this.nodes.values()) conn.send({ t: 'ping', ts: Date.now() });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  close(): void {
    clearInterval(this.heartbeatTimer);
    for (const conn of this.nodes.values()) conn.socket.end();
    this.server.close();
  }
}

export class Conn {
  readonly socket: net.Socket;
  manifest?: NodeManifest;
  node_id = '';
  rtt: number | null = null;
  private callSeq = 0;

  constructor(sock: net.Socket, private readonly hub: NodeProtocolServer) {
    this.socket = sock;
    // P2-1 混合帧解码：控制行 JSON 走 #handle；bin 块按 stream 路由 binSinks；流失步即断连
    const dec = new WireDecoder({
      onFrame: (msg) => {
        if (msg['t'] === '__bad_json') {
          this.hub.opts.onLog(`坏帧（JSON 解析失败）：${String(msg['raw']).slice(0, 100)}`);
          return;
        }
        try { this.#handle(msg); } catch (e) {
          this.hub.opts.onLog(`帧处理异常 t=${String(msg['t'])}：${String((e as Error).message ?? e).slice(0, 200)}`);
        }
      },
      onBin: (h, payload) => {
        const sink = this.hub.binSinks.get(h.stream);
        if (!sink) return; // 迟到/未知流：丢弃
        try { sink.onChunk(h.seq, payload); } catch (e) {
          this.hub.opts.onLog(`bin 汇处理异常 stream=${h.stream}：${String((e as Error).message ?? e).slice(0, 200)}`);
        }
      },
      onViolation: (reason) => {
        this.hub.opts.onLog(`帧协议流失步，断连（${this.node_id || '未入册'}）：${reason}`);
        sock.destroy();
      },
    });
    sock.on('data', (chunk: Buffer) => dec.push(chunk));
    sock.on('close', () => this.#offline());
    sock.on('error', () => this.#offline());
  }

  send(obj: Record<string, unknown>): void {
    try { this.socket.write(JSON.stringify(obj) + '\n'); } catch { /* 断线由 close 处理 */ }
  }

  /** bin 帧写出（背压：write false 等 drain） */
  async sendBin(header: { stream: string; seq: number; bytes: number }, payload: Buffer): Promise<void> {
    if (!this.socket.write(encodeBinFrame(header, payload))) await new Promise<void>((r) => this.socket.once('drain', r));
  }

  handle(): NodeHandle {
    return { node_id: this.node_id, manifest: this.manifest!, rtt_ms: this.rtt, last_heartbeat: Date.now() };
  }

  allocCallId(): string {
    this.callSeq += 1;
    return `c-${Date.now().toString(36)}-${this.callSeq}-${Math.random().toString(36).slice(2, 8)}`;
  }

  #handle(msg: Record<string, unknown>): void {
    switch (msg['t']) {
      case 'hello': {
        const manifest = msg['manifest'] as NodeManifest;
        const sig = String(msg['sig'] ?? '');
        const pubkeyHex = String(msg['pubkey'] ?? '');
        // 签名上报校验（01 §3.4）；node_id 必须与公钥指纹一致（01 §2.1）
        const pubDer = Buffer.from(pubkeyHex, 'hex');
        const expectId = createHash('sha256').update(pubDer).digest('hex').slice(0, 16);
        const keyObj = this.hub.pubkeys.get(manifest.node_id) ?? createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
        this.hub.pubkeys.set(manifest.node_id, keyObj);
        const okSig = cryptoVerify(null, Buffer.from(canonicalJson(manifest), 'utf8'), keyObj, Buffer.from(sig, 'hex'));
        if (!okSig || expectId !== manifest.node_id) {
          this.hub.opts.onLog(`拒绝节点：签名/node_id 校验失败（${manifest.display_name}）`);
          this.socket.end();
          return;
        }
        this.manifest = manifest;
        this.node_id = manifest.node_id;
        this.hub.nodes.set(this.node_id, this);
        // 入册持久化（P0 write-through）；**保留既有 overlay/degraded**——重报 manifest（P1-3）不得抹掉 hub 侧状态
        const prevRec = this.hub.opts.db.nodes[this.node_id];
        this.hub.opts.db.nodes[this.node_id] = { ...(prevRec ?? {}), manifest, last_seen: new Date().toISOString() };
        saveHubDb(this.hub.opts.home, this.hub.opts.db);
        this.hub.opts.onLog(`节点上线：${manifest.display_name} (${this.node_id})，工作区 ${manifest.workspaces.length} 个`);
        const ov = this.hub.opts.getOverlay?.(this.node_id);
        this.send(ov ? { t: 'welcome', epoch: 1, overlay: ov } : { t: 'welcome', epoch: 1 });
        // 重连对账：未决调用逐条裁决（01 §4.3）
        if (this.hub.pending.size > 0) this.hub.reconcile(this.node_id, this);
        return;
      }
      case 'reconcile_result': {
        const verdicts = (msg['verdicts'] as JournalVerdictDetail[]) ?? [];
        this.#reconcileVerdicts(verdicts);
        this.hub.opts.onReconciled?.(this.node_id, verdicts);
        return;
      }
      case 'audit_records': {
        const records = (msg['records'] as AuditRecord[]) ?? [];
        this.hub.opts.onAuditRecords?.(this.node_id, records, Number(msg['last_seq'] ?? 0));
        return;
      }
      case 'call_result': {
        const callId = String(msg['call_id'] ?? '');
        const env = msg['envelope'] as ResultEnvelope;
        const pending = this.hub.pending.get(callId);
        if (pending) {
          this.hub.pending.delete(callId);
          clearTimeout(pending.timer);
          // hub 签发时间戳（时钟偏移免疫，红队 P2-6）+ node_id 权威化
          pending.resolve({ ...env, node_id: this.node_id, call_id: callId, ts_hub: Date.now() });
          return;
        }
        // 不在 pending：审批续跑（job_continue）的结果，按 job_id 回注 job 注册表
        const jobId = msg['job_id'] !== undefined && msg['job_id'] !== null ? String(msg['job_id']) : undefined;
        if (jobId) this.hub.opts.onJobResult?.(jobId, { ...env, node_id: this.node_id, ts_hub: Date.now() });
        return; // 迟到结果（对账后重发已被判死）丢弃
      }
      case 'bin_abort': {
        // P2-1：节点流块中断（socket 死/文件变更）→ 通知编排器弃 staging
        const stream = String(msg['stream'] ?? '');
        const sink = this.hub.binSinks.get(stream);
        sink?.onAbort?.(String(msg['reason'] ?? '节点中止'));
        this.hub.binSinks.delete(stream);
        return;
      }
      case 'pong': {
        const ts = Number(msg['ts'] ?? 0);
        if (ts) this.rtt = Date.now() - ts;
        return;
      }
      default:
        return;
    }
  }

  /** 对账裁决落地（01 §4.3）：result_available→取回留存结果；safe_redispatch/never_seen→透明重发；unknown_reconcile→判 unknown */
  #reconcileVerdicts(verdicts: JournalVerdictDetail[]): void {
    for (const v of verdicts) {
      const pending = this.hub.pending.get(v.id);
      if (!pending) continue;
      if (v.verdict === 'safe_redispatch' || v.verdict === 'never_seen') {
        this.send({ t: 'call', call_id: pending.call_id, kind: pending.kind, params: pending.params }); // 透明重发，同一 call_id
        continue;
      }
      if (v.verdict === 'unknown_reconcile') {
        this.#resolvePending(pending, {
          status: 'unknown', node_id: this.node_id, call_id: pending.call_id, ts_hub: Date.now(),
          error: {
            class: 'network', retryable: false,
            message: `对账：journal=started，结局不明，禁止重发。先确认是否已发生（检查副作用/节点侧 journal）再决定后续动作`,
          },
        });
        continue;
      }
      if (v.verdict === 'result_available') {
        // 节点已完成但结果未送达：用 journal_fetch 取回留存结果
        this.send({ t: 'call', call_id: pending.call_id, kind: 'journal_fetch', params: { orig_call_id: pending.call_id } });
      }
      // corrupt：保持 pending 到超时
    }
  }

  #resolvePending(pending: PendingCall, env: ResultEnvelope): void {
    this.hub.pending.delete(pending.call_id);
    clearTimeout(pending.timer);
    pending.resolve({ ...env, node_id: this.node_id, call_id: pending.call_id, ts_hub: Date.now() });
  }

  #offline(): void {
    if (!this.node_id || !this.hub.nodes.has(this.node_id)) return;
    this.hub.nodes.delete(this.node_id);
    this.hub.opts.onLog(`节点离线：${this.node_id}`);
    // 在途 bin 流一并作废（编排器凭 onAbort 弃 staging）
    for (const [stream, sink] of this.hub.binSinks) {
      const p = this.hub.pending.get(stream);
      if (p && p.node_id === this.node_id) {
        sink.onAbort?.('节点断连');
        this.hub.binSinks.delete(stream);
      }
    }
    // 在途调用立即判 unknown（离线后无法送达结果；重连对账兜底）
    for (const p of [...this.hub.pending.values()]) {
      if (p.node_id === this.node_id) {
        this.#resolvePending(p, {
          status: 'unknown', node_id: this.node_id, call_id: p.call_id, ts_hub: Date.now(),
          error: { class: 'network', retryable: false, message: '节点在调用期间断连：结局不明（journal 对账后可续），禁止盲目重发' },
        });
      }
    }
    this.hub.opts.onNodeOffline?.(this.node_id);
  }
}
