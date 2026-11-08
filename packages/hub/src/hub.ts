/**
 * Hub 核心：MCP JSON-RPC 分发 + 工具路由 + 信封裁决（01 §4.3 错误分类学的 hub 侧落地）。
 */
import type { ResultEnvelope, OverlayConfig } from '@mdp/contract';
import { STANDARD } from '@mdp/contract';
import { NodeProtocolServer, type NodeHandle } from './nodeproto.js';
import { HubJobs, type HubJob } from './jobs.js';
import { TOOL_DEFS } from './mcp-tools.js';
import { saveHubDb, type HubDbShape } from './state.js';

export interface HubOptions {
  home: string;
  db: HubDbShape;
  nodePort: number;
  log: (line: string) => void;
  /** 审批 TTL（01 §6 默认 6h；测试经 env 调短） */
  approvalTtlMs?: number;
}

const DEFAULT_EXEC_TIMEOUT_MS = 120000;
const MAX_EXEC_TIMEOUT_MS = 1800000;
const CALL_MARGIN_MS = 10000;

export class Hub {
  readonly nodeServer: NodeProtocolServer;
  readonly jobs: HubJobs;
  private readonly ttlMs: number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: HubOptions) {
    this.log = opts.log;
    this.ttlMs = opts.approvalTtlMs ?? Number(process.env['MDP_APPROVAL_TTL_MS'] ?? 6 * 3600 * 1000);
    this.nodeServer = new NodeProtocolServer({
      port: opts.nodePort,
      home: opts.home,
      db: opts.db,
      onLog: this.log,
      onReconciled: (nodeId, verdicts) => {
        if (verdicts.length > 0) this.log(`对账完成：${nodeId} → ${verdicts.map((v) => `${v.id}:${v.verdict}`).join(', ')}`);
      },
      onJobResult: (jobId, env) => {
        this.jobs.finish(jobId, env);
        this.log(`job ${jobId} 终态：${env.status}（exit=${env.result?.exit ?? '-'})`);
      },
      getOverlay: (nodeId) => this.getOverlay(nodeId),
    });
    this.jobs = new HubJobs((job) => this.#continueJob(job));
    this.nodeServer.startHeartbeat();
  }

  /** 取节点 overlay；首次 hello（db 已注册）懒创建 standard 预设（P1-1，01 §3.2） */
  getOverlay(nodeId: string): OverlayConfig | undefined {
    const rec = this.opts.db.nodes[nodeId];
    if (!rec) return undefined;
    if (!rec.overlay) {
      const ov: OverlayConfig = { ...STANDARD, mode: 'standard', path_domains: rec.manifest.workspaces.map((w) => w.path), epoch: 1 };
      rec.overlay = ov;
      saveHubDb(this.opts.home, this.opts.db);
      this.log(`overlay 初始化：${rec.manifest.display_name} → standard（域 ${ov.path_domains.length} 个）`);
    }
    return rec.overlay;
  }

  /** overlay 变更：合并 → 持久化 → 在线节点即时推送（01 §3.2） */
  updateOverlay(nodeId: string, patch: Partial<OverlayConfig>): OverlayConfig | undefined {
    const rec = this.opts.db.nodes[nodeId];
    if (!rec) return undefined;
    const cur = this.getOverlay(nodeId)!;
    const next: OverlayConfig = {
      ...cur,
      ...patch,
      levels: { ...cur.levels, ...(patch.levels ?? {}) },
    };
    rec.overlay = next;
    saveHubDb(this.opts.home, this.opts.db);
    this.nodeServer.pushOverlay(nodeId, next);
    this.log(`overlay 更新：${rec.manifest.display_name} → fs=${next.levels.fs} exec=${next.levels.exec} gate=${next.content_gate} 白名单 ${next.command_patterns_allow.length} 条`);
    return next;
  }

  get nodePort(): number {
    return this.nodeServer.port;
  }

  close(): void {
    this.jobs.close();
    this.nodeServer.close();
  }

  #continueJob(job: HubJob): void {
    const conn = this.nodeServer.nodes.get(job.node_id);
    if (!conn) {
      job.state = 'denied';
      job.envelope = {
        status: 'denied', node_id: job.node_id, call_id: job.call?.call_id ?? '', ts_hub: Date.now(),
        error: { class: 'offline', retryable: false, message: '批准时节点已离线，任务终止（重新入池后再试）' },
      };
      return;
    }
    this.log(`审批通过，续跑 job ${job.job_id}（node=${job.node_id}）`);
    conn.send({ t: 'job_continue', job_id: job.job_id, call: { call_id: job.call!.call_id, kind: job.call!.kind, params: job.call!.params } });
  }

  /** 节点解析：display_name / node_id；离线但曾入册的节点给出 offline 信封素材 */
  #findNode(name: string): { handle: NodeHandle } | { offlineMsg: string } {
    const online = this.nodeServer.byName(name);
    if (online) return { handle: online };
    for (const [id, rec] of Object.entries(this.opts.db.nodes)) {
      if (id === name || rec.manifest.display_name === name) {
        return { offlineMsg: `节点 ${name} 当前离线（最后心跳 ${rec.last_seen}）。nodes() 可见离线节点；勿反复重试` };
      }
    }
    return { offlineMsg: `池内无节点 ${name}。先调用 nodes() 查看可用节点` };
  }

  #offlineEnvelope(msg: string, callId: string): ResultEnvelope {
    return { status: 'failed', node_id: '', call_id: callId, ts_hub: Date.now(), error: { class: 'offline', retryable: false, message: msg } };
  }

  /** nodes()：节点/工作区/健康/权限摘要 + 未消费 job 计数（01 §4.1） */
  nodesSnapshot(): Record<string, unknown> {
    const online = this.nodeServer.listHandles().map((h) => ({
      node_id: h.node_id,
      display_name: h.manifest.display_name,
      online: true,
      available: h.manifest.available,
      os: h.manifest.os,
      arch: h.manifest.arch,
      shell: h.manifest.shell,
      agent_version: h.manifest.agent_version,
      capabilities: h.manifest.capabilities,
      workspaces: h.manifest.workspaces,
      native_enforcement: h.manifest.native_enforcement,
      self_description: h.manifest.self_description,
      // overlay 摘要（01 §3.3 注入大脑：节点侧闸门当前状态，hub 为事实源）
      overlay: (() => {
        const o = this.getOverlay(h.node_id);
        return o ? { levels: o.levels, content_gate: o.content_gate, path_domains: o.path_domains.length, allowlist: o.command_patterns_allow.length } : undefined;
      })(),
      rtt_ms: h.rtt_ms,
      unconsumed_jobs: this.jobs.unconsumedFor(h.node_id),
    }));
    const offline = Object.entries(this.opts.db.nodes)
      .filter(([id]) => !this.nodeServer.isOnline(id))
      .map(([id, rec]) => ({
        node_id: id,
        display_name: rec.manifest.display_name,
        online: false,
        last_seen: rec.last_seen,
        workspaces: rec.manifest.workspaces,
        unconsumed_jobs: this.jobs.unconsumedFor(id),
      }));
    return { nodes: [...online, ...offline], hub_version: '0.1.0' };
  }

  async #toolCall(name: string, args: Record<string, unknown>): Promise<ResultEnvelope> {
    switch (name) {
      case 'nodes':
        return { status: 'ok', node_id: 'hub', call_id: '', ts_hub: Date.now(), result: { exit: 0, stdout: JSON.stringify(this.nodesSnapshot()), stderr: '', truncated: false } };

      case 'exec':
      case 'fs':
      case 'job_submit': {
        const nodeName = String(args['node'] ?? '');
        const found = this.#findNode(nodeName);
        if ('offlineMsg' in found) return this.#offlineEnvelope(found.offlineMsg, '');
        const params = { ...args } as Record<string, unknown>;
        delete params['node'];
        const timeoutMs = Math.min(Number(args['timeout_ms'] ?? DEFAULT_EXEC_TIMEOUT_MS), MAX_EXEC_TIMEOUT_MS);
        const deadline = name === 'exec' ? timeoutMs + CALL_MARGIN_MS : 120000;
        let env = await this.nodeServer.dispatch(found.handle.node_id, name, params, deadline);

        // 内容闸命中 → 转 job（01 §6）；后台 job 入 hub 注册表（job_status 路由）
        if (env.status === 'needs_approval') {
          const job = this.jobs.createApproval(found.handle.node_id, { kind: name, params, call_id: env.call_id }, this.ttlMs);
          env = { ...env, job: { job_id: job.job_id, state: 'needs_approval' } }; // 统一以 hub 注册表的 job_id 为准
          this.log(`审批卡：node=${found.handle.manifest.display_name} job=${job.job_id} cmd=${String(params['cmd'] ?? '').slice(0, 80)}`);
        } else if (env.status === 'ok' && env.job?.job_id) {
          this.jobs.registerBackground(found.handle.node_id, env.job.job_id, String(params['cmd'] ?? ''));
        }
        return env;
      }

      case 'job_status': {
        const jobId = String(args['job_id'] ?? '');
        const job = this.jobs.jobs.get(jobId);
        if (job) {
          // hub 侧 job：审批 job 与经 hub 注册的后台 job
          if (job.state === 'needs_approval') {
            return { status: 'ok', node_id: 'hub', call_id: '', ts_hub: Date.now(),
              result: { exit: null, stdout: JSON.stringify({ job_id: jobId, state: 'needs_approval', cmd: job.cmd }), stderr: '', truncated: false } };
          }
          if (job.envelope) {
            return { status: 'ok', node_id: 'hub', call_id: '', ts_hub: Date.now(),
              result: { exit: null, stdout: JSON.stringify({ job_id: jobId, state: job.state, envelope: job.envelope }), stderr: '', truncated: false } };
          }
          // running（已批准续跑中）：等节点回 call_result → jobs.finish；先回当前状态
          return { status: 'ok', node_id: 'hub', call_id: '', ts_hub: Date.now(),
            result: { exit: null, stdout: JSON.stringify({ job_id: jobId, state: job.state }), stderr: '', truncated: false } };
        }
        // 未知 job：转发到其来源节点查询（节点本地后台 job）
        const found = this.#findNode(String(args['node'] ?? '')) ;
        if ('handle' in found) {
          return this.nodeServer.dispatch(found.handle.node_id, 'job_status', { job_id: jobId }, 30000);
        }
        return { status: 'failed', node_id: 'hub', call_id: '', ts_hub: Date.now(),
          error: { class: 'crash', retryable: false, message: `job ${jobId} 不存在于 hub 注册表；若来自离线节点，待其上线后可查` } };
      }

      case 'job_output': {
        const ref = String(args['output_ref'] ?? '');
        const m = /^job:([\w-]+)#/.exec(ref);
        if (m) {
          const job = this.jobs.jobs.get(m[1]!);
          if (job?.envelope?.result) {
            // 审批 job 的全量输出已在 hub 留存
            const offset = Number(args['offset'] ?? 0);
            const limit = Number(args['limit'] ?? 8192);
            const full = (job.envelope.result.stdout ?? '') + (job.envelope.result.stderr ?? '');
            return { status: 'ok', node_id: 'hub', call_id: '', ts_hub: Date.now(),
              result: { exit: null, stdout: JSON.stringify({ total: full.length, data: full.slice(offset, offset + limit), truncated: full.length > offset + limit }), stderr: '', truncated: false } };
          }
        }
        // 其余转发节点 job 目录分页
        const refNode = m ? this.jobs.jobs.get(m[1]!)?.node_id : undefined;
        const nodeName = refNode ?? String(args['node'] ?? '');
        const found = this.#findNode(nodeName);
        if ('offlineMsg' in found) return this.#offlineEnvelope(found.offlineMsg, '');
        return this.nodeServer.dispatch(found.handle.node_id, 'job_output', { output_ref: ref, offset: args['offset'], limit: args['limit'] }, 30000);
      }

      case 'job_cancel': {
        const jobId = String(args['job_id'] ?? '');
        const job = this.jobs.jobs.get(jobId);
        if (job && job.state === 'needs_approval') {
          this.jobs.deny(jobId, 'job_cancel');
          return { status: 'ok', node_id: 'hub', call_id: '', ts_hub: Date.now(),
            result: { exit: null, stdout: JSON.stringify({ job_id: jobId, state: 'denied', via: 'job_cancel' }), stderr: '', truncated: false } };
        }
        if (job) {
          const conn = this.nodeServer.nodes.get(job.node_id);
          if (conn) {
            conn.send({ t: 'call', call_id: conn.allocCallId(), kind: 'job_cancel', params: { job_id: jobId } });
            // 乐观落地终态（节点 job_update 随后覆盖确认；离线时保持 cancelled，语义等价 01 §6）
            job.state = 'cancelled';
            job.envelope = { status: 'ok', node_id: job.node_id, call_id: '', ts_hub: Date.now(),
              result: { exit: null, stdout: JSON.stringify({ job_id: jobId, state: 'cancelled', via: 'job_cancel' }), stderr: '', truncated: false },
              job: { job_id: jobId, state: 'cancelled' } };
            this.jobs.jobs.set(jobId, job);
            return { status: 'ok', node_id: 'hub', call_id: '', ts_hub: Date.now(),
              result: { exit: null, stdout: JSON.stringify({ job_id: jobId, state: 'cancelled', via: 'job_cancel' }), stderr: '', truncated: false } };
          }
        }
        return { status: 'failed', node_id: 'hub', call_id: '', ts_hub: Date.now(),
          error: { class: 'offline', retryable: false, message: `job ${jobId} 所在节点不可达` } };
      }

      default:
        return { status: 'failed', node_id: 'hub', call_id: '', ts_hub: Date.now(),
          error: { class: 'crash', retryable: false, message: `未知工具 ${name}（静态基线见 tools/list；transfer/handoff 属 P2/P5）` } };
    }
  }

  /** MCP JSON-RPC 入口（mcp.ts 调用）；返回 undefined 表示 notification（HTTP 202） */
  async handleJsonRpc(msg: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const method = String(msg['method'] ?? '');
    const id = msg['id'];
    const params = (msg['params'] ?? {}) as Record<string, unknown>;
    const isNotification = id === undefined || id === null;

    if (isNotification) return undefined;

    const reply = (result: unknown, isError = false): Record<string, unknown> =>
      isError
        ? { jsonrpc: '2.0', id, error: result as Record<string, unknown> }
        : { jsonrpc: '2.0', id, result };

    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: String(params['protocolVersion'] ?? '2024-11-05'),
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'mdp', version: '0.1.0' },
          instructions: '多设备池：先 nodes() 确认节点与工作区，再 exec/fs；信封 status 非 ok 时按 error.class 处理（permission 永不重试；unknown 先对账）。',
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOL_DEFS });
      case 'tools/call': {
        const name = String(params['name'] ?? '');
        const args = (params['arguments'] ?? {}) as Record<string, unknown>;
        try {
          const env = await this.#toolCall(name, args);
          return reply({ content: [{ type: 'text', text: envelopeTextSafe(env) }], isError: false });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: `工具执行框架错误：${String((e as Error).message ?? e)}` }], isError: true });
        }
      }
      default:
        return reply({ code: -32601, message: `Method not found: ${method}` }, true);
    }
  }
}

const envelopeTextSafe = (env: ResultEnvelope): string => JSON.stringify(env, null, 2);
