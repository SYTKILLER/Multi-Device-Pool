/**
 * overlay（01 §3.2）——node agent 在执行路径上强制的确定性闸（P0 最小实现）。
 *
 * 远程调用的有效闸门 = overlay（这里）+ LLM 自我约束（概率层）；harness 原生只管本地（01 §3.1）。
 * P0 范围：路径域（realpath 判定 + exec cwd 夹紧）+ 内容闸初版模式集 + busy 检测。
 * P1 补全：levels 细分轴（deny/read-only/workspaces/allowlist/full）、hub 下发即时生效、学习式白名单累积。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceConfig } from './config.js';

export type GateVerdict =
  | { kind: 'allow' }
  | { kind: 'deny'; message: string }
  | { kind: 'approval'; message: string };

/** 内容闸初版模式集（01 §3.2）——命中 → 强制审批，不自动拒绝 */
const CONTENT_GATE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, label: '递归强删 rm -rf' },
  { re: /Remove-Item\s+[^|]*-Recurse/i, label: '递归强删 Remove-Item -Recurse' },
  { re: /\b(curl|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|powershell|pwsh|iex|Invoke-Expression)\b/i, label: '管道执行 curl|sh' },
  { re: /\bgit\s+push\b[^&]*--force/i, label: 'git push --force' },
  { re: /\b(reg\s+add|regedit\s+\/s|schtasks\s+\/create|Set-ItemProperty\s+.*-Path\s+.*Registry)/i, label: '注册表/启动项/计划任务写入' },
  { re: /\b(format|diskpart|dd|mkfs)\b/i, label: '磁盘类操作' },
];

export class Overlay {
  constructor(private readonly workspaces: WorkspaceConfig[]) {}

  workspaceByName(name: string): WorkspaceConfig | undefined {
    return this.workspaces.find((w) => w.name === name);
  }

  /** cwd 解析：workspace:<name> 符号引用优先；绝对路径允许但过 realpath 域检查（01 §4.2） */
  resolveDir(cwd: string | undefined): { ok: true; dir: string; ws: WorkspaceConfig } | { ok: false; message: string } {
    if (!cwd) {
      const w0 = this.workspaces[0];
      if (!w0) return { ok: false, message: '节点未配置任何工作区，无默认 cwd' };
      return { ok: true, dir: w0.path, ws: w0 };
    }
    const m = /^workspace:([A-Za-z0-9_-]+)$/.exec(cwd);
    if (m) {
      const ws = this.workspaceByName(m[1]!);
      if (!ws) return { ok: false, message: `未知工作区引用 ${cwd}（本节点有：${this.workspaces.map((w) => w.name).join(', ') || '无'}）` };
      return { ok: true, dir: ws.path, ws };
    }
    // 绝对路径：realpath 后必须落在某个工作区内（路径域，01 §3.2 path_domains）
    const abs = path.resolve(cwd);
    const real = this.realpath(abs);
    for (const ws of this.workspaces) {
      const wsReal = this.realpath(ws.path);
      if (real === wsReal || real.startsWith(wsReal + path.sep)) return { ok: true, dir: abs, ws };
    }
    return { ok: false, message: `路径 ${cwd} 超出本节点工作区范围（overlay fs/exec=workspaces）` };
  }

  /** fs 路径判定：workspace:<name>/rel 或绝对路径，统一 realpath 域检查 */
  resolveFsPath(p: string): { ok: true; abs: string; ws: WorkspaceConfig } | { ok: false; message: string } {
    const wm = /^workspace:([A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(p);
    if (wm) {
      const ws = this.workspaceByName(wm[1]!);
      if (!ws) return { ok: false, message: `未知工作区引用 ${p}` };
      const abs = path.resolve(ws.path, wm[2] ?? '');
      return this.#within(abs, ws);
    }
    const abs = path.resolve(p);
    for (const ws of this.workspaces) {
      const wsReal = this.realpath(ws.path);
      const real = this.realpath(abs);
      if (real === wsReal || real.startsWith(wsReal + path.sep)) return { ok: true, abs, ws };
    }
    return { ok: false, message: `路径 ${p} 超出本节点工作区范围（overlay）` };
  }

  /** 内容闸：命中即审批（不自动拒绝，01 §3.2） */
  contentGate(cmd: string): GateVerdict {
    for (const { re, label } of CONTENT_GATE_PATTERNS) {
      if (re.test(cmd)) return { kind: 'approval', message: `内容闸拦截：${label} 需审批` };
    }
    return { kind: 'allow' };
  }

  /** busy 检测（01 §5.2 v1）：写类操作前查 .git/index.lock → busy */
  busyCheck(wsPath: string): string | undefined {
    const lock = path.join(wsPath, '.git', 'index.lock');
    return fs.existsSync(lock) ? `工作区锁冲突：${lock} 存在（另一进程可能正操作该仓库）` : undefined;
  }

  realpath(p: string): string {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p); // 不存在的路径按词法解析（写入型操作稍后由 fs 层报错）
    }
  }

  #within(abs: string, ws: WorkspaceConfig): { ok: true; abs: string; ws: WorkspaceConfig } | { ok: false; message: string } {
    const real = this.realpath(abs);
    const wsReal = this.realpath(ws.path);
    if (real === wsReal || real.startsWith(wsReal + path.sep)) return { ok: true, abs, ws };
    // 符号链接逃逸检查：词法在内、realpath 出界 → 明确拒绝（红队 P1-11 前置）
    if (abs === real) return { ok: false, message: `路径 ${abs} 超出工作区 ${ws.name} 范围（overlay）` };
    return { ok: false, message: `路径 ${abs} 经符号链接解析到 ${real}，超出工作区 ${ws.name} 范围（overlay 拒绝链接逃逸）` };
  }
}
