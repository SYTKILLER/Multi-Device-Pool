/**
 * node agent 主循环：连 hub（TCP，换行分隔 JSON 控制帧；v1 跨机时外层换 TLS 即可）、
 * 上报 manifest（签名）、处理 dispatch（overlay 三检 → journal → 执行 → 结果信封）与对账。
 * 心跳：hub ping / node pong，RTT 由 hub 计算（01 §5.1）。
 */
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { NodeManifest, ResultEnvelope } from '@mdp/contract';
import type { NodeConfig, WorkspaceConfig } from './config.js';
import { Overlay } from './overlay.js';
import { Journal } from './journal.js';
import { runExec, defaultShell, type ExecSpec } from './exec.js';
import { fsOp } from './fsops.js';
import { NodeJobs } from './node-jobs.js';
import { canonicalJson, type NodeIdentity } from './identity.js';

export interface AgentOptions {
  home: string;
  config: NodeConfig;
  identity: NodeIdentity;
  onLog?: (line: string) => void;
}

interface WorkspaceEntryLite extends WorkspaceConfig {
  revision: number;
  workspace_id: string;
  superseded: boolean;
}

export class NodeAgent {
  readonly manifest: NodeManifest;
  readonly overlay: Overlay;
  readonly journal: Journal;
  readonly jobs: NodeJobs;
  private socket?: net.Socket;
  private connected = false;
  private stopped = false;
  private retryMs = 500;
  private log: (line: string) => void;

  constructor(private readonly opts: AgentOptions) {
    this.log = opts.onLog ?? ((l) => console.log(`[node] ${l}`));
    this.overlay = new Overlay(opts.config.workspaces);
    this.journal = new Journal(path.join(opts.home, 'jobs')); // 01 §4.3：journal 持久化于 ~/.mdp/jobs/
    this.jobs = new NodeJobs(opts.home);
    // 后台 job 终态上报：hub 侧 job_status 依赖（call_id 无对应 pending → 按 job_id 回注）
    this.jobs.onDone = (job) => {
      this.#send({ t: 'call_result', call_id: `bg-${job.job_id}`, job_id: job.job_id, envelope: {
        status: 'ok', node_id: this.manifest.node_id, call_id: `bg-${job.job_id}`, ts_hub: 0,
        result: { exit: job.exit, stdout: '', stderr: '', truncated: false },
        job: { job_id: job.job_id, state: job.state },
      } });
    };
    this.manifest = this.#buildManifest();
  }

  #buildManifest(): NodeManifest {
    const wsEntries: WorkspaceEntryLite[] = this.opts.config.workspaces.map((w) => {
      const id = createHash('sha256').update(w.path).digest('hex').slice(0, 12);
      const revision = this.#revisionOf(w);
      return { name: w.name, path: w.path, revision, workspace_id: id, superseded: false };
    });
    const structured = {
      levels: { fs: 'workspaces', exec: 'workspaces', transfer: 'workspaces' },
      path_domains: this.opts.config.workspaces.map((w) => w.path),
      command_patterns_allow: this.opts.config.command_patterns_allow ?? [],
    };
    return {
      manifest_version: 3,
      node_id: this.opts.identity.node_id,
      display_name: this.opts.config.display_name,
      os: `${os.type().toLowerCase()}${process.platform === 'win32' ? '-win' + os.release().split('.')[0] : ''}`,
      arch: os.arch(),
      shell: defaultShell(),
      // P1-4 测试钩子：MDP_AGENT_VERSION 模拟旧版本节点（版本协商验收）
      agent_version: process.env['MDP_AGENT_VERSION'] ?? '0.1.0',
      capabilities: ['exec', 'fs'],
      workspaces: wsEntries,
      available: 'session',
      native_enforcement: 'none', // P0 无 harness hook 接入（01 §3.4：none → GUI 标记"无强制"）
      self_description: {
        structured,
        text: `P0 node agent：exec/fs 限工作区内；内容闸默认开启（approval）。`,
      },
    };
  }

  #revisionOf(w: WorkspaceConfig): number {
    // P0：revision = 路径内容指纹的粗代理（配置文件 mtime）。P2 pool-transfer 接管血统。
    try {
      return Number(fs_statMtime(w.path));
    } catch {
      return 0;
    }
  }

  start(): void {
    this.#connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.end();
  }

  #connect(): void {
    if (this.stopped) return;
    const [host, port] = this.opts.config.hub.split(':');
    const sock = net.connect(Number(port), host);
    this.socket = sock;
    let buf = '';
    sock.on('connect', () => {
      this.connected = true;
      this.retryMs = 500;
      this.log(`已连接 hub ${this.opts.config.hub}（node_id=${this.manifest.node_id}）`);
      const m = this.manifest;
      const sig = this.opts.identity.sign(canonicalJson(m));
      this.#send({ t: 'hello', manifest: m, sig, pubkey: this.opts.identity.publicKeyHex });
    });
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        void this.#handle(msg);
      }
    });
    sock.on('close', () => {
      if (!this.connected) return; // 连接失败走 error 分支
      this.connected = false;
      this.log('与 hub 断开，准备重连');
      this.#retry();
    });
    sock.on('error', (e: Error) => {
      this.connected = false;
      this.log(`连接失败：${e.message}，${this.retryMs}ms 后重试`);
      this.#retry();
    });
  }

  #retry(): void {
    if (this.stopped) return;
    setTimeout(() => this.#connect(), this.retryMs);
    this.retryMs = Math.min(Math.round(this.retryMs * 1.5), 15000); // 指数退避（01 §5.1）
  }

  #send(obj: Record<string, unknown>): void {
    this.socket?.write(JSON.stringify(obj) + '\n');
  }

  async #handle(msg: Record<string, unknown>): Promise<void> {
    switch (msg['t']) {
      case 'welcome': {
        this.log(`hub 欢迎：epoch=${msg['epoch']}`);
        // P1-1：hub 下发 overlay（hub 是唯一事实源），即时生效
        if (msg['overlay']) {
          this.overlay.setOverlay(msg['overlay'] as Parameters<Overlay['setOverlay']>[0]);
          const l = this.overlay.config.levels;
          this.log(`overlay 生效：fs=${l.fs} exec=${l.exec} transfer=${l.transfer} 域=${this.overlay.config.path_domains.length || this.manifest.workspaces.length} 个`);
        }
        return;
      }
      case 'overlay': {
        this.overlay.setOverlay(msg['overlay'] as Parameters<Overlay['setOverlay']>[0]);
        const l = this.overlay.config.levels;
        this.log(`overlay 推送即时生效：fs=${l.fs} exec=${l.exec} transfer=${l.transfer}`);
        return;
      }
      case 'ping':
        this.#send({ t: 'pong', ts: msg['ts'] });
        return;
      case 'reconcile': {
        const ids = (msg['ids'] as string[]) ?? [];
        this.#send({ t: 'reconcile_result', verdicts: this.journal.reconcile(ids) });
        return;
      }
      case 'job_continue': {
        // 审批通过：hub 把原始 call 原文回传；approved=true 表示内容闸已由人工放行（deny/busy 检查仍然执行）
        await this.#dispatch(msg['call'] as Record<string, unknown>, msg['job_id'] as string | undefined, true);
        return;
      }
      case 'call':
        await this.#dispatch(msg, undefined);
        return;
      default:
        return;
    }
  }

  /** 执行路径唯一强制点（01 §1.2）：overlay 三检 → journal → 执行 → 结果信封 */
  async #dispatch(msg: Record<string, unknown>, jobId: string | undefined, approved = false): Promise<void> {
    const callId = msg['call_id'] as string;
    const kind = msg['kind'] as string;
    const params = (msg['params'] ?? {}) as Record<string, unknown>;

    const denyEnvelope = (cls: 'permission' | 'busy', message: string): ResultEnvelope => ({
      status: 'denied', node_id: this.manifest.node_id, call_id: callId, ts_hub: 0,
      error: { class: cls, retryable: false, message },
    });

    try {
      if (kind === 'exec' || kind === 'job_submit') {
        const cmd = String(params['cmd'] ?? '');
        // P1-1 全量判定链：等级轴 → cwd 域夹紧 → busy → 内容闸/学习式白名单（01 §3.2）
        const verdict = this.overlay.checkExec(cmd, params['cwd'] as string | undefined, approved);
        if (verdict.kind === 'deny') return this.#send({ t: 'call_result', call_id: callId, job_id: jobId, envelope: denyEnvelope('permission', verdict.message) });
        if (verdict.kind === 'busy') return this.#send({ t: 'call_result', call_id: callId, job_id: jobId, envelope: {
          status: 'failed', node_id: this.manifest.node_id, call_id: callId, ts_hub: 0,
          error: { class: 'busy', retryable: false, message: verdict.message },
        } });
        if (verdict.kind === 'approval') {
          // 内容闸命中 → 转审批，不 journal（无副作用发生；批准后从 received 起走正常路径）
          return this.#send({ t: 'call_result', call_id: callId, job_id: jobId, envelope: {
            status: 'needs_approval', node_id: this.manifest.node_id, call_id: callId, ts_hub: 0,
            job: { job_id: jobId ?? '', state: 'needs_approval' },
            error: { class: 'permission', retryable: false, message: verdict.message },
          } });
        }
        const spec: ExecSpec = {
          cmd, dir: verdict.dir!,
          shell: params['shell'] as string | undefined,
          timeout_ms: params['timeout_ms'] as number | undefined,
        };
        if (kind === 'job_submit' || params['background'] === true) {
          // journal 不覆盖后台 job 的 started 界（job 有独立状态机与留存，01 §6）
          const newJobId = jobId ?? callId;
          const job = this.jobs.submit(newJobId, spec, spec.shell);
          return this.#send({ t: 'call_result', call_id: callId, job_id: jobId, envelope: {
            status: 'ok', node_id: this.manifest.node_id, call_id: callId, ts_hub: 0,
            result: { exit: null, stdout: '', stderr: '', truncated: false, output_ref: `job:${newJobId}#0` },
            job: { job_id: newJobId, state: job.state as 'running' },
          } });
        }
        // 前台 exec：received → started → finished（01 §4.3 journal）
        this.journal.mark(callId, 'received');
        this.journal.mark(callId, 'started');
        const outcome = await runExec(spec);
        this.jobs.recordSync(callId, outcome);
        this.journal.mark(callId, 'finished', { exit: outcome.exit, output_ref: `job:${callId}#0` });
        const baseResult = { exit: outcome.exit, stdout: outcome.stdout, stderr: outcome.stderr, truncated: outcome.truncated, output_ref: `job:${callId}#0` };
        const env: ResultEnvelope = outcome.timedOut
          ? { status: 'timeout', node_id: this.manifest.node_id, call_id: callId, ts_hub: 0,
              error: { class: 'timeout', retryable: false, message: `命令超时（${spec.timeout_ms ?? 0}ms）已被终止；部分输出留存于 output_ref`, }, result: baseResult }
          : outcome.crash
            ? { status: 'failed', node_id: this.manifest.node_id, call_id: callId, ts_hub: 0,
                error: { class: 'crash', retryable: false, message: `spawn 失败：${outcome.crash}` } }
            : { status: 'ok', node_id: this.manifest.node_id, call_id: callId, ts_hub: 0, result: baseResult };
        return this.#send({ t: 'call_result', call_id: callId, job_id: jobId, envelope: env });
      }

      if (kind === 'fs') {
        const op = String(params['op'] ?? '');
        // P1-1：fs 等级轴先判（deny/read-only/workspaces），再路径域，再 busy
        const lvl = this.overlay.checkFsLevel(op);
        if (lvl.kind === 'deny') return this.#send({ t: 'call_result', call_id: callId, job_id: jobId, envelope: denyEnvelope('permission', lvl.message) });
        if (op === 'write') {
          const r = this.overlay.resolveFsPath(String(params['path'] ?? ''));
          if (r.ok) {
            const busy = this.overlay.busyCheck(r.ws.path);
            if (busy) return this.#send({ t: 'call_result', call_id: callId, job_id: jobId, envelope: {
              status: 'failed', node_id: this.manifest.node_id, call_id: callId, ts_hub: 0,
              error: { class: 'busy', retryable: false, message: busy },
            } });
          }
        }
        const outcome = fsOp(this.overlay, op, params as never);
        if (!outcome.ok) return this.#send({ t: 'call_result', call_id: callId, job_id: jobId, envelope: denyEnvelope('permission', outcome.error ?? 'fs 被拒绝') });
        // 写类 fs 有副作用：journal 覆盖（01 §4.3）；读类跳过（允许透明重试）
        if (op === 'write') {
          this.journal.mark(callId, 'received');
          this.journal.mark(callId, 'started');
          this.journal.mark(callId, 'finished', { exit: 0 });
        }
        return this.#send({ t: 'call_result', call_id: callId, job_id: jobId, envelope: {
          status: 'ok', node_id: this.manifest.node_id, call_id: callId, ts_hub: 0,
          result: { exit: 0, stdout: JSON.stringify(outcome.data), stderr: '', truncated: false },
        } });
      }

      if (kind === 'job_status') {
        const job = this.jobs.get(String(params['job_id'] ?? ''));
        return this.#send({ t: 'call_result', call_id: callId, job_id: jobId, envelope: {
          status: 'ok', node_id: this.manifest.node_id, call_id: callId, ts_hub: 0,
          result: { exit: null, stdout: JSON.stringify(job ?? { job_id: params['job_id'], state: 'unknown' }), stderr: '', truncated: false },
        } });
      }
      if (kind === 'job_output') {
        const out = this.jobs.readOutput(String(params['output_ref'] ?? params['job_id'] ?? ''), Number(params['offset'] ?? 0), Number(params['limit'] ?? 8192));
        return this.#send({ t: 'call_result', call_id: callId, job_id: jobId, envelope: out
          ? { status: 'ok', node_id: this.manifest.node_id, call_id: callId, ts_hub: 0, result: { exit: null, stdout: JSON.stringify(out), stderr: '', truncated: false } }
          : denyEnvelope('permission', `output_ref 不存在：${String(params['output_ref'] ?? '')}`) });
      }
      if (kind === 'job_cancel') {
        const ok = this.jobs.cancel(String(params['job_id'] ?? ''));
        return this.#send({ t: 'call_result', call_id: callId, job_id: jobId, envelope: {
          status: 'ok', node_id: this.manifest.node_id, call_id: callId, ts_hub: 0,
          result: { exit: null, stdout: JSON.stringify({ cancelled: ok }), stderr: '', truncated: false },
        } });
      }

      this.#send({ t: 'call_result', call_id: callId, job_id: jobId, envelope: denyEnvelope('permission', `未知调用类型 ${kind}`) });
    } catch (e) {
      // 节点侧未捕获异常 → failed/crash（01 §4.3 class: crash）
      this.#send({ t: 'call_result', call_id: callId, job_id: jobId, envelope: {
        status: 'failed', node_id: this.manifest.node_id, call_id: callId, ts_hub: 0,
        error: { class: 'crash', retryable: false, message: `节点执行异常：${String((e as Error).message ?? e)}` },
      } });
    }
  }
}

const fs_statMtime = (p: string): number => {
  return Math.round(fs.statSync(p).mtimeMs / 1000);
};
