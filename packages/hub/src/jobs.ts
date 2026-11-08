/**
 * hub 侧 job 注册表（01 §6）：
 * - needs_approval：内容闸命中的调用转 job，GUI/API 批准后经 job_continue 续跑；TTL 6h 默认 deny。
 * - 后台 job（job_submit/background）：结果留存 7 天；job_status/job_output 查询；job 注册表持久化。
 * 审批人 = 持管理令牌者（P0：REST /jobs/:id/approve|deny 代理 GUI 审批卡，01 §7）。
 */
import { randomBytes } from 'node:crypto';
import type { ResultEnvelope } from '@mdp/contract';

export interface HubJob {
  job_id: string;
  node_id: string;
  kind: 'approval' | 'background';
  state: 'needs_approval' | 'running' | 'finished' | 'denied' | 'expired' | 'cancelled';
  /** 原始调用（批准后续跑用） */
  call?: { kind: string; params: Record<string, unknown>; call_id: string };
  cmd?: string;
  created_at: number;
  ttl_ms: number;
  /** 审批人令牌 ID（审计，01 §6） */
  approved_by?: string;
  envelope?: ResultEnvelope;
  /** 审批合并：多个观察者等待同一 job 的终态（V5 审批合并的池层形态） */
  waiters: Array<(env: ResultEnvelope) => void>;
}

export class HubJobs {
  readonly jobs = new Map<string, HubJob>();
  private sweeper?: NodeJS.Timeout;

  constructor(private readonly onContinue: (job: HubJob) => void) {
    const ttlSweepMs = Number(process.env['MDP_TTL_SWEEP_MS'] ?? 1000);
    this.sweeper = setInterval(() => this.sweep(), ttlSweepMs);
    this.sweeper.unref?.();
  }

  createApproval(nodeId: string, call: { kind: string; params: Record<string, unknown>; call_id: string }, ttlMs: number): HubJob {
    const job: HubJob = {
      job_id: `j-${randomBytes(4).toString('hex')}`,
      node_id: nodeId,
      kind: 'approval',
      state: 'needs_approval',
      call,
      cmd: String(call.params['cmd'] ?? ''),
      created_at: Date.now(),
      ttl_ms: ttlMs,
      waiters: [],
    };
    this.jobs.set(job.job_id, job);
    return job;
  }

  registerBackground(nodeId: string, jobId: string, cmd: string): HubJob {
    const job: HubJob = {
      job_id: jobId,
      node_id: nodeId,
      kind: 'background',
      state: 'running',
      cmd,
      created_at: Date.now(),
      ttl_ms: 0,
      waiters: [],
    };
    this.jobs.set(jobId, job);
    return job;
  }

  /** 审批落卡（节点名 + 命令全文 + 倒计时，01 §6）；返回 false = 已终态/不存在 */
  approve(jobId: string, approverTokenId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== 'needs_approval') return false;
    job.state = 'running';
    job.approved_by = approverTokenId.slice(0, 8);
    this.onContinue(job);
    return true;
  }

  deny(jobId: string, approverTokenId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== 'needs_approval') return false;
    job.state = 'denied';
    job.approved_by = approverTokenId.slice(0, 8);
    job.envelope = {
      status: 'denied', node_id: job.node_id, call_id: job.call?.call_id ?? '', ts_hub: Date.now(),
      error: { class: 'permission', retryable: false, message: `审批被拒绝（TTL 前人工 deny / approver=${job.approved_by}）` },
    };
    this.#releaseWaiters(job);
    return true;
  }

  /** TTL 到期默认 deny（01 §6） */
  sweep(): void {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.state === 'needs_approval' && job.ttl_ms > 0 && now - job.created_at > job.ttl_ms) {
        job.state = 'expired';
        job.envelope = {
          status: 'denied', node_id: job.node_id, call_id: job.call?.call_id ?? '', ts_hub: now,
          error: { class: 'permission', retryable: false, message: `审批超时（TTL ${Math.round(job.ttl_ms / 1000)}s）默认 deny（01 §6）` },
        };
        this.#releaseWaiters(job);
      }
    }
  }

  finish(jobId: string, env: ResultEnvelope): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    // 终态优先取信封携带的 job 状态（如 cancelled），否则按信封 status 归类
    job.state = env.job?.state ?? (env.status === 'denied' ? 'denied' : 'finished');
    job.envelope = env;
    this.#releaseWaiters(job);
  }

  /** 等待 job 终态（job_status 轮询的推送化；审批合并场景多方等待同一 job） */
  wait(jobId: string, timeoutMs: number): Promise<ResultEnvelope | undefined> {
    const job = this.jobs.get(jobId);
    if (!job) return Promise.resolve(undefined);
    if (job.envelope && job.state !== 'running' && job.state !== 'needs_approval') return Promise.resolve(job.envelope);
    return new Promise((resolve) => {
      let done = false;
      const w = (env: ResultEnvelope) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(env);
      };
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(undefined);
      }, timeoutMs);
      t.unref?.();
      job.waiters.push(w);
    });
  }

  #releaseWaiters(job: HubJob): void {
    const env = job.envelope;
    if (!env) return;
    for (const w of job.waiters) w(env);
    job.waiters = [];
  }

  /** 未消费 job 计数（nodes() 返回，新会话的大脑可见历史 job，01 §6） */
  unconsumedFor(nodeId: string): number {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.node_id === nodeId && job.kind === 'approval' && job.state === 'finished') n += 1;
    }
    return n;
  }

  close(): void {
    clearInterval(this.sweeper);
  }
}
