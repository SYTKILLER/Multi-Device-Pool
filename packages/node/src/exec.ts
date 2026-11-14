/**
 * exec 执行器（01 §4.2）。
 * V2 实证修订（2026-11-07，docs/verification-p0.md）：
 * - chcp 65001 对管道输出无效；唯一有效通路是 PowerShell 前缀包装
 *   `[Console]::OutputEncoding=[Text.Encoding]::UTF8; <cmd>`（PS5.1/pwsh7 通吃，stdout+stderr 双路）。
 * - shell=cmd 时按系统 codepage（GBK/gb18030）解码兜底。
 * - git 中文文件名八进制转义是 core.quotepath 行为，由工具描述引导（非本层职责）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface ExecSpec {
  cmd: string;
  dir: string;            // overlay 夹紧后的绝对 cwd
  shell?: string;         // powershell | pwsh | cmd | bash；缺省按平台
  timeout_ms?: number;
}

export interface ExecOutcome {
  exit: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  crash?: string;         // spawn 级失败（如 shell 本身不存在）
  timedOut?: boolean;     // 超时被终止（hub 归类 timeout，01 §4.3）
  duration_ms: number;
}

/** inline 上限 64KB（01 §4.2）：头+尾截断标记；全量落节点 job 目录 */
const INLINE_CAP = 64 * 1024;
const HALF = INLINE_CAP / 2;

/** inline 上限截断（头+尾保留，全量落节点 job 目录）；job 终态信封摘要复用 */
export const truncate = (s: string): { text: string; cut: boolean } => {
  if (Buffer.byteLength(s, 'utf8') <= INLINE_CAP) return { text: s, cut: false };
  return { text: s.slice(0, HALF) + `\n…[截断：全量见 output_ref]…\n` + s.slice(-HALF), cut: true };
};

const decode = (buf: Buffer, shell: string): string => {
  if (shell === 'cmd') {
    try { return new TextDecoder('gb18030').decode(buf); } catch { return buf.toString('latin1'); }
  }
  return buf.toString('utf8');
};

/** shell 包装（V2 唯一有效通路） */
export const wrapCommand = (cmd: string, shell: string): { file: string; args: string[]; enc: string } => {
  switch (shell) {
    case 'powershell':
      return { file: 'powershell', args: ['-NoProfile', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${cmd}`], enc: 'utf8' };
    case 'pwsh':
      return { file: 'pwsh', args: ['-NoProfile', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${cmd}`], enc: 'utf8' };
    case 'cmd':
      return { file: 'cmd', args: ['/d', '/s', '/c', cmd], enc: 'gb18030' };
    case 'bash':
      return { file: 'bash', args: ['-c', cmd], enc: 'utf8' };
    default:
      // 未知 shell 值：按可执行文件直解（不存在 → spawn ENOENT → crash 分类）
      return { file: shell, args: ['-c', cmd], enc: 'utf8' };
  }
};

export const defaultShell = (): string => (process.platform === 'win32' ? 'powershell' : 'bash');

export const runExec = (spec: ExecSpec): Promise<ExecOutcome> =>
  new Promise((resolve) => {
    const shell = spec.shell ?? defaultShell();
    const { file, args } = wrapCommand(spec.cmd, shell);
    const started = Date.now();
    let child;
    try {
      child = spawn(file, args, { cwd: spec.dir, windowsHide: true });
    } catch (e) {
      resolve({ exit: null, stdout: '', stderr: '', truncated: false, crash: String((e as Error).message ?? e), duration_ms: Date.now() - started });
      return;
    }
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timer = spec.timeout_ms
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
        }, spec.timeout_ms)
      : undefined;

    child.stdout?.on('data', (c: Buffer) => outChunks.push(c));
    child.stderr?.on('data', (c: Buffer) => errChunks.push(c));
    child.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exit: null, stdout: '', stderr: '', truncated: false, crash: e.message, duration_ms: Date.now() - started });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const so = truncate(decode(Buffer.concat(outChunks), shell));
      const se = truncate(decode(Buffer.concat(errChunks), shell));
      resolve({
        exit: timedOut ? null : code,
        stdout: so.text,
        stderr: se.text,
        truncated: so.cut || se.cut || timedOut,
        timedOut,
        duration_ms: Date.now() - started,
      });
    });
  });

/** 全量输出落节点 job 目录（01 §4.2），供 job_output 分页 */
export const persistOutput = (jobsDir: string, callId: string, outcome: ExecOutcome): string => {
  const dir = path.join(jobsDir, callId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'output.txt');
  fs.writeFileSync(file, `--- stdout ---\n${outcome.stdout}\n--- stderr ---\n${outcome.stderr}\n--- exit=${outcome.exit ?? 'null'} ---\n`);
  return file;
};
