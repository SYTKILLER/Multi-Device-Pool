/**
 * overlay（01 §3.2）——node agent 在执行路径上强制的确定性闸（P1-1 全量实装）。
 *
 * 远程调用的有效闸门 = overlay（这里）+ LLM 自我约束（概率层）；harness 原生只管本地（01 §3.1）。
 * 等级轴：deny < read-only < workspaces < allowlist < full（contract LEVEL_ORDER）。
 * - fs：read 类 ≥ read-only；write 类 ≥ workspaces（allowlist 轴对 fs 与 workspaces 同义——写仍限路径域）
 * - exec：≥ workspaces 需 cwd 在路径域内；= allowlist 时命令必须命中 command_patterns_allow
 * - 路径域：realpath 判定（符号链接逃逸拒绝）+ Windows 大小写折叠（红队 P1-11）
 * - 内容闸：命中 → 审批（P1-2 起：模式表每节点可编辑 + 学习式白名单免批）
 * - overlay 由 hub 下发（welcome + 即时推送），节点侧不做持久化（hub 是唯一事实源）
 */
import fs from 'node:fs';
import path from 'node:path';
import { levelAtLeast, type OverlayConfig, type OverlayLevel } from '@mdp/contract';
import { STANDARD } from '@mdp/contract';
import type { WorkspaceConfig } from './config.js';

export type GateVerdict =
  | { kind: 'allow'; dir?: string; abs?: string; ws?: WorkspaceConfig }
  | { kind: 'deny'; message: string }
  | { kind: 'busy'; message: string }   // 01 §4.3 独立 busy 分类（.git/index.lock 等），不同于 permission
  | { kind: 'approval'; message: string };

/** 内容闸内建初版模式集（01 §3.2）——overlay.content_gate_patterns 非空时整体覆盖 */
const BUILTIN_GATE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, label: '递归强删 rm -rf' },
  { re: /Remove-Item\s+[^|]*-Recurse/i, label: '递归强删 Remove-Item -Recurse' },
  { re: /\b(curl|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|powershell|pwsh|iex|Invoke-Expression)\b/i, label: '管道执行 curl|sh' },
  { re: /\bgit\s+push\b[^&]*--force/i, label: 'git push --force' },
  { re: /\b(reg\s+add|regedit\s+\/s|schtasks\s+\/create|Set-ItemProperty\s+.*-Path\s+.*Registry)/i, label: '注册表/启动项/计划任务写入' },
  { re: /\b(format|diskpart|dd|mkfs)\b/i, label: '磁盘类操作' },
];

const FS_READ_OPS = new Set(['read', 'list', 'glob', 'grep']);

export class Overlay {
  #cfg: OverlayConfig;
  #workspaces: WorkspaceConfig[];
  /** realpath 归一后的路径域（win32 折叠大小写）；空 = 工作区路径 */
  #domains: Array<{ raw: string; real: string }>;

  constructor(workspaces: WorkspaceConfig[], cfg?: OverlayConfig) {
    this.#workspaces = workspaces;
    this.#cfg = cfg ?? this.#defaultOverlay();
    this.#domains = this.#buildDomains();
  }

  #defaultOverlay(): OverlayConfig {
    return { ...STANDARD, mode: 'standard', path_domains: this.#workspaces.map((w) => w.path), epoch: 1 };
  }

  #buildDomains(): Array<{ raw: string; real: string }> {
    const raws = this.#cfg.path_domains.length > 0 ? this.#cfg.path_domains : this.#workspaces.map((w) => w.path);
    return raws.map((raw) => ({ raw, real: this.#fold(this.realpath(raw)) }));
  }

  /** hub 下发 overlay：即时生效（01 §3.2 变更即生效；在跑 job 不受影响） */
  setOverlay(cfg: OverlayConfig): void {
    this.#cfg = cfg;
    this.#domains = this.#buildDomains();
  }

  get config(): OverlayConfig {
    return this.#cfg;
  }

  workspaceByName(name: string): WorkspaceConfig | undefined {
    return this.#workspaces.find((w) => w.name === name);
  }

  #fold(p: string): string {
    return process.platform === 'win32' ? p.toLowerCase() : p; // 红队 P1-11：大小写折叠
  }

  realpath(p: string): string {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p); // 不存在的路径按词法解析（写入型操作稍后由 fs 层报错）
    }
  }

  #withinDomains(realFolded: string): boolean {
    return this.#domains.some((d) => realFolded === d.real || realFolded.startsWith(d.real + path.sep));
  }

  /** exec 等级判定（P1-1）：deny→拒；workspaces→cwd 夹紧路径域；allowlist→须命中白名单 */
  #execLevelCheck(cmd: string): GateVerdict {
    const lvl: OverlayLevel = this.#cfg.levels.exec;
    if (!this.#cfg.enabled || lvl === 'deny') return { kind: 'deny', message: `overlay：exec=${this.#cfg.enabled ? lvl : 'disabled'}，执行被池层禁止` };
    if (lvl === 'allowlist') {
      const hit = this.#cfg.command_patterns_allow.some((p) => p === '*' || cmd.startsWith(p));
      if (!hit) return { kind: 'deny', message: `overlay：exec=allowlist，命令未命中学习式白名单（${this.#cfg.command_patterns_allow.length} 条前缀）` };
    }
    return { kind: 'allow' };
  }

  /** cwd 解析：workspace:<name> 符号引用优先；绝对路径允许但过 realpath 域检查 + exec cwd 夹紧（01 §4.2） */
  resolveDir(cwd: string | undefined): { ok: true; dir: string; ws: WorkspaceConfig } | { ok: false; message: string } {
    let dir: string;
    let ws: WorkspaceConfig | undefined;
    const m = /^workspace:([A-Za-z0-9_-]+)$/.exec(cwd ?? '');
    if (m) {
      ws = this.workspaceByName(m[1]!);
      if (!ws) return { ok: false, message: `未知工作区引用 ${cwd}（本节点有：${this.#workspaces.map((w) => w.name).join(', ') || '无'}）` };
      dir = ws.path;
    } else if (cwd) {
      dir = path.resolve(cwd); // 绝对路径：词法解析折叠 .. 后再过域检查
    } else {
      const w0 = this.#workspaces[0];
      if (!w0) return { ok: false, message: '节点未配置任何工作区，无默认 cwd' };
      ws = w0;
      dir = w0.path;
    }
    const real = this.#fold(this.realpath(dir));
    if (!this.#withinDomains(real)) {
      return { ok: false, message: `路径 ${cwd ?? dir} 超出本节点路径域（overlay exec cwd 夹紧，fs/exec=${this.#cfg.levels.exec}）` };
    }
    return { ok: true, dir, ws: ws ?? this.#workspaces[0]! };
  }

  /** fs 路径判定：workspace:<name>/rel 或绝对路径，统一 realpath 域检查（含符号链接逃逸拒绝） */
  resolveFsPath(p: string): { ok: true; abs: string; ws: WorkspaceConfig } | { ok: false; message: string } {
    const wm = /^workspace:([A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(p);
    let abs: string;
    let ws: WorkspaceConfig;
    if (wm) {
      const w = this.workspaceByName(wm[1]!);
      if (!w) return { ok: false, message: `未知工作区引用 ${p}` };
      ws = w;
      abs = path.resolve(w.path, wm[2] ?? '');
    } else {
      abs = path.resolve(p);
      const w = this.#workspaces.find((w) => {
        const real = this.#fold(this.realpath(abs));
        const wsReal = this.#fold(this.realpath(w.path));
        return real === wsReal || real.startsWith(wsReal + path.sep);
      });
      if (!w) return { ok: false, message: `路径 ${p} 超出本节点工作区范围（overlay）` };
      ws = w;
    }
    const real = this.#fold(this.realpath(abs));
    const wsReal = this.#fold(this.realpath(ws.path));
    const inWs = real === wsReal || real.startsWith(wsReal + path.sep);
    const inDomains = this.#withinDomains(real);
    if (!inWs && !inDomains) {
      // 符号链接逃逸检查：词法在内、realpath 出界 → 明确拒绝（红队 P1-11 前置）
      if (abs === this.realpath(abs)) return { ok: false, message: `路径 ${abs} 超出工作区 ${ws.name} 范围（overlay）` };
      return { ok: false, message: `路径 ${abs} 经符号链接解析到 ${this.realpath(abs)}，超出工作区 ${ws.name} 范围（overlay 拒绝链接逃逸）` };
    }
    return { ok: true, abs, ws };
  }

  /** fs 等级判定（P1-1）：deny→全拒；read-only→仅读类；≥workspaces→读写（写仍限路径域） */
  checkFsLevel(op: string): GateVerdict {
    const lvl: OverlayLevel = this.#cfg.levels.fs;
    if (!this.#cfg.enabled || lvl === 'deny') return { kind: 'deny', message: `overlay：fs=${this.#cfg.enabled ? lvl : 'disabled'}，文件操作被池层禁止` };
    const isRead = FS_READ_OPS.has(op);
    if (isRead) return levelAtLeast(lvl, 'read-only') ? { kind: 'allow' } : { kind: 'deny', message: `overlay：fs=${lvl} 低于 read-only，${op} 被拒绝` };
    return levelAtLeast(lvl, 'workspaces') ? { kind: 'allow' } : { kind: 'deny', message: `overlay：fs=${lvl} 低于 workspaces，写类操作 ${op} 被拒绝` };
  }

  /** 内容闸：命中即审批（不自动拒绝，01 §3.2）；off（full_access）、白名单命中或已批准 → 放行 */
  contentGate(cmd: string, approved = false): GateVerdict {
    if (this.#cfg.content_gate === 'off' || approved) return { kind: 'allow' };
    // 学习式白名单优先（P1-2：首次前缀审批后同类免批）
    if (this.#cfg.command_patterns_allow.some((p) => p === '*' || cmd.startsWith(p))) return { kind: 'allow' };
    const patterns = (this.#cfg.content_gate_patterns?.length ?? 0) > 0
      ? this.#cfg.content_gate_patterns!.map((s) => ({ re: new RegExp(s, 'i'), label: s }))
      : BUILTIN_GATE_PATTERNS;
    for (const { re, label } of patterns) {
      if (re.test(cmd)) return { kind: 'approval', message: `内容闸拦截：${label} 需审批` };
    }
    return { kind: 'allow' };
  }

  /** exec 全链判定（P1-1 组装）：等级 → cwd 域 → busy → 内容闸/白名单；approved=true 跳过审批（deny/busy 仍生效） */
  checkExec(cmd: string, cwd: string | undefined, approved = false): GateVerdict {
    const lvl = this.#execLevelCheck(cmd);
    if (lvl.kind === 'deny') return lvl;
    const dir = this.resolveDir(cwd);
    if (!dir.ok) return { kind: 'deny', message: dir.message };
    const busy = this.busyCheck(dir.ws.path);
    if (busy) return { kind: 'busy', message: busy };
    const gate = this.contentGate(cmd, approved);
    if (gate.kind !== 'allow') return gate;
    return { kind: 'allow', dir: dir.dir, ws: dir.ws };
  }

  /** busy 检测（01 §5.2 v1）：写类操作前查 .git/index.lock → busy */
  busyCheck(wsPath: string): string | undefined {
    const lock = path.join(wsPath, '.git', 'index.lock');
    return fs.existsSync(lock) ? `工作区锁冲突：${lock} 存在（另一进程可能正操作该仓库）` : undefined;
  }
}
