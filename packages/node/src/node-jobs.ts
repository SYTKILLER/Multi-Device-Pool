/**
 * 后台 job（01 §4.1/§6）：job_submit 与 background:true 的执行形态。
 * 节点侧职责：派生进程、状态跟踪、全量输出落盘、cancel。
 * 审批状态机与 TTL 在 hub；这里只管执行与结果留存。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { wrapCommand, defaultShell, persistOutput, type ExecSpec, type ExecOutcome } from './exec.js';

export type NodeJobState = 'running' | 'finished' | 'failed' | 'cancelled';

export interface NodeJob {
  job_id: string;
  state: NodeJobState;
  cmd: string;
  dir: string;
  exit: number | null;
  pid?: number;
  output_file?: string;
  started_at: string;
  finished_at?: string;
}

export class NodeJobs {
  readonly dir: string;
  /** job 终态回调（agent 用来上报 hub 与写审计；cancel 也触发）；outcome 为终止时的输出 */
  onDone?: (job: NodeJob, outcome: ExecOutcome) => void;
  #jobs = new Map<string, NodeJob>();
  #children = new Map<string, ChildProcess>();

  constructor(home: string) {
    this.dir = path.join(home, 'jobs');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  get(jobId: string): NodeJob | undefined {
    return this.#jobs.get(jobId);
  }

  /** 阻塞式 exec 的全量输出同样落 job 目录，使 output_ref 分页可用 */
  recordSync(callId: string, outcome: ExecOutcome): void {
    persistOutput(this.dir, callId, outcome);
  }

  outputRef(callId: string): string {
    return `job:${callId}#0`;
  }

  /** 分页取回全量输出（01 §4.2 job_output；offset/limit 按字符切） */
  readOutput(ref: string, offset = 0, limit = 8 * 1024): { total: number; data: string; truncated: boolean } | undefined {
    const m = /#(\d+)$/.exec(ref);
    const id = ref.startsWith('job:') ? ref.slice(4).replace(/#\d+$/, '') : undefined;
    if (!m || !id) return undefined;
    const file = path.join(this.dir, id, 'output.txt');
    try {
      const text = fs.readFileSync(file, 'utf8');
      const off = offset;
      return { total: text.length, data: text.slice(off, off + limit), truncated: text.length > off + limit };
    } catch {
      return undefined;
    }
  }

  /** 后台派生：立即返回 running，结束时落盘并改状态 */
  submit(jobId: string, spec: ExecSpec, shellOverride?: string): NodeJob {
    const shell = shellOverride ?? spec.shell ?? defaultShell();
    const { file, args } = wrapCommand(spec.cmd, shell);
    const job: NodeJob = {
      job_id: jobId,
      state: 'running',
      cmd: spec.cmd,
      dir: spec.dir,
      exit: null,
      started_at: new Date().toISOString(),
    };
    this.#jobs.set(jobId, job);
    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: spec.dir, windowsHide: true });
    } catch (e) {
      job.state = 'failed';
      job.finished_at = new Date().toISOString();
      job.output_file = persistOutput(this.dir, jobId, { exit: null, stdout: '', stderr: `spawn 失败：${String((e as Error).message ?? e)}`, truncated: false, duration_ms: 0 });
      return job;
    }
    job.pid = child.pid;
    this.#children.set(jobId, child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const outFile = path.join(this.dir, jobId, 'output.txt');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `--- job ${jobId}（运行中）---\n`); // 立即存在：running 期 job_output 可取增量
    const append = (s: string): void => { try { fs.appendFileSync(outFile, s); } catch { /* 忽略写失败 */ } };
    child.stdout?.on('data', (c: Buffer) => { out.push(c); append(decodeBuf([c], shell)); });
    child.stderr?.on('data', (c: Buffer) => { err.push(c); append(decodeBuf([c], shell)); });
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e: Error) => {
      job.state = 'failed';
      job.exit = null;
      job.finished_at = new Date().toISOString();
      const outcome: ExecOutcome = { exit: null, stdout: decodeBuf(out, shell), stderr: decodeBuf(err, shell) + `\nspawn error: ${e.message}`, truncated: false, crash: e.message, duration_ms: 0 };
      job.output_file = persistOutput(this.dir, jobId, outcome);
      this.onDone?.(job, outcome);
    });
    child.on('close', (code) => {
      this.#children.delete(jobId);
      const outcome: ExecOutcome = { exit: job.state === 'cancelled' ? null : code, stdout: decodeBuf(out, shell), stderr: decodeBuf(err, shell), truncated: false, duration_ms: 0 };
      if (job.state !== 'cancelled') {
        job.exit = code;
        job.state = 'finished';
        job.finished_at = new Date().toISOString();
        job.output_file = persistOutput(this.dir, jobId, outcome);
      }
      this.onDone?.(job, outcome);
    });
    return job;
  }

  cancel(jobId: string): boolean {
    const job = this.#jobs.get(jobId);
    if (!job || job.state !== 'running') return false;
    const child = this.#children.get(jobId);
    if (child) {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      this.#children.delete(jobId);
    }
    job.state = 'cancelled';
    job.exit = null;
    job.finished_at = new Date().toISOString();
    return true;
  }
  // 注：cancel 的 onDone 由 child close 事件触发（进程被杀时 close 仍会发出）
}

const decodeBuf = (chunks: Buffer[], shell: string): string => {
  const buf = Buffer.concat(chunks);
  if (shell === 'cmd') {
    try { return new TextDecoder('gb18030').decode(buf); } catch { return buf.toString('latin1'); }
  }
  return buf.toString('utf8');
};
