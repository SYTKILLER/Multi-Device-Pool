/**
 * mdp file（P2-4 大载荷旁路，e71e080 坑 #3 落地）：文件内容永不进对话/MCP 参数，
 * 只走磁盘直读与 transfer 二进制通道；每步输出 sha256 供双侧比对。
 *
 *   mdp file stash <本地文件> <workspace:w/rel> --ws <本地工作区绝对路径>
 *       本地直复制进工作区（不调 MCP——节点侧文件入池第一步，绕过对话转录）
 *   mdp file push <hub宿主文件> --node <目标节点> --path workspace:w/rel
 *       transfer_push 包装（hub 宿主侧：src 即 hub 本地路径）
 *   mdp file pull <源节点> <workspace:w/rel> --out <本地目标路径>
 *       transfer_fetch 包装：落 hub 收件箱后复制到 --out，收件箱哈希与 transfer 报告比对
 *
 * 连接参数（push/pull）：--hub <url> --token <hex>；缺省依次读
 * <home>/hub-info.json（hub 宿主形态，地址 127.0.0.1:<mcp_port>）与 ./.mdp-hub-token.json（节点交接形态）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { homeOf } from './home.js';

export const sha256File = (file: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 交接文件查找：从 cwd 向上逐级找 .mdp-hub-token.json（上限 5 级——agent cwd 常为仓库根而工作区在其下一层，同 git 找 .git 惯例） */
const findHandoff = (): string | undefined => {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++, dir = path.dirname(dir)) {
    const cand = path.join(dir, '.mdp-hub-token.json');
    if (fs.existsSync(cand)) return cand;
    if (dir === path.dirname(dir)) break;
  }
  return undefined;
};

/** 连接信息解析：显式 --hub/--token > --token-file（交接文件，节点形态）> cwd 向上找 .mdp-hub-token.json > <home>/hub-info.json（hub 宿主形态）。
 * hub-info.json 兜底且交接优先于它：节点机可能残留陈年 hub-info.json（如本机曾自环跑过 hub），指向 127.0.0.1 会误连（2026-11-21 B 机实测踩中）。 */
export const resolveConn = (opts: { hub?: string; token?: string; tokenFile?: string }): { hub: string; token: string } => {
  if (opts.hub && opts.token) return { hub: opts.hub, token: opts.token };
  const hand = opts.tokenFile ?? findHandoff();
  if (hand) {
    const j = JSON.parse(fs.readFileSync(hand, 'utf8')) as { hub: string; token: string };
    return { hub: opts.hub ?? j.hub, token: opts.token ?? j.token };
  }
  try {
    const info = JSON.parse(fs.readFileSync(path.join(homeOf(), 'hub-info.json'), 'utf8')) as { token: string; mcp_port: number };
    return { hub: opts.hub ?? `http://127.0.0.1:${info.mcp_port}`, token: opts.token ?? info.token };
  } catch {
    console.error('[mdp file] 未找到连接信息：传 --hub/--token（或 --token-file），或在本机 ~/.mdp/hub-info.json / ./.mdp-hub-token.json 任一处提供');
    process.exit(2);
  }
};

const callMcp = async (conn: { hub: string; token: string }, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  let res: Response;
  try {
    res = await fetch(`${conn.hub}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
  } catch (e) {
    console.error(`[mdp file] hub 不可达（${conn.hub}）：${String((e as Error).cause ?? e)}——核对 hub 是否在线、--hub/--token-file 是否指对机器`);
    process.exit(1);
  }
  const j = (await res.json()) as { result?: { content?: { text: string }[] }; error?: { message: string } };
  if (j.error) { console.error(`[mdp file] MCP 错误：${j.error.message}`); process.exit(1); }
  return JSON.parse(j.result!.content![0]!.text) as Record<string, unknown>;
};

/** 信封 → transfer outcome（stdout JSON 包装层，见 docs/02 §5 回填注记） */
const outcomeOf = (env: Record<string, unknown>): { file_sha256?: string; bytes?: number; inbox_path?: string; transfer_id?: string } => {
  if (env.status !== 'ok') { console.error(`[mdp file] transfer 失败：${JSON.stringify(env).slice(0, 400)}`); process.exit(1); }
  const r = env['result'] as { stdout?: string } | undefined;
  return JSON.parse(r!.stdout!) as { file_sha256?: string; bytes?: number; inbox_path?: string; transfer_id?: string };
};

const WS_REF = /^workspace:([A-Za-z0-9_-]+)[/\\](.+)$/;

/** workspace 相对路径校验：拒绝 `..` 段与空段（overlay 同款词法规则，红队 P1-11——stash 是本地操作无 hub 检查，CLI 必须自证） */
const wsRelOf = (wsRef: string): { ws: string; rel: string } | undefined => {
  const m = WS_REF.exec(wsRef);
  if (!m) return undefined;
  const segs = m[2]!.split(/[/\\]/);
  if (segs.some((s) => s === '..' || s === '')) return undefined;
  return { ws: m[1]!, rel: m[2]! };
};

/** 取形如 --key value / --key=value 的参数 */
const argOf = (argv: string[], key: string): string | undefined => {
  const i = argv.indexOf(key);
  if (i < 0) return undefined;
  if (argv[i + 1]?.startsWith('--')) return undefined;
  return argv[i + 1];
};

export const runFile = async (argv: string[]): Promise<void> => {
  const action = argv[0];
  const rest = argv.slice(1);

  if (action === 'stash') {
    // stash：纯本地复制，零 MCP。源哈希与落盘哈希同算一次即可（copyFile 后重读比对防内存路径差异）
    const [src, wsRef] = rest.filter((a) => !a.startsWith('--'));
    const wsDir = argOf(rest, '--ws');
    if (!src || !wsRef || !wsDir) {
      console.error('用法：mdp file stash <本地文件> <workspace:w/rel> --ws <本地工作区绝对路径>');
      process.exit(2);
    }
    const rel = wsRelOf(wsRef);
    if (!rel) { console.error(`workspace 引用须形如 workspace:repo/dist/a.bin（相对路径不得含 .. 或空段），实得 ${wsRef}`); process.exit(2); }
    const dest = path.join(wsDir, rel.rel.replace(/\//g, path.sep));
    const before = sha256File(src);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    const after = sha256File(dest);
    if (before !== after) { console.error(`[mdp file] stash 后哈希不一致（源 ${before} vs 落盘 ${after}）`); process.exit(1); }
    console.log(`[mdp file] stash ok：${dest}`);
    console.log(`sha256=${after} bytes=${fs.statSync(dest).size}`);
    return;
  }

  if (action === 'push') {
    const [src] = rest.filter((a) => !a.startsWith('--'));
    const node = argOf(rest, '--node');
    const wsRef = argOf(rest, '--path');
    if (!src || !node || !wsRef) {
      console.error('用法：mdp file push <hub宿主文件> --node <目标节点> --path workspace:w/rel');
      process.exit(2);
    }
    if (!wsRelOf(wsRef)) { console.error(`workspace 引用须形如 workspace:repo/dist/a.bin（相对路径不得含 .. 或空段），实得 ${wsRef}`); process.exit(2); }
    const conn = resolveConn({ hub: argOf(rest, '--hub'), token: argOf(rest, '--token'), tokenFile: argOf(rest, '--token-file') });
    const localSha = sha256File(src);
    const oc = outcomeOf(await callMcp(conn, 'transfer_push', { node, src: path.resolve(src), path: wsRef }));
    const ok = oc.file_sha256 === localSha;
    console.log(`[mdp file] push ${ok ? 'ok' : 'SHA 不一致!'}：node=${node} path=${wsRef} transfer_id=${oc.transfer_id}`);
    console.log(`sha256=${oc.file_sha256} bytes=${oc.bytes} 本地=${localSha}`);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (action === 'pull') {
    // pull：<node> 工作区文件 → hub 收件箱 →（--out 给了）复制到本地，双重哈希比对
    const [node, wsRef] = rest.filter((a) => !a.startsWith('--'));
    const out = argOf(rest, '--out');
    if (!node || !wsRef) {
      console.error('用法：mdp file pull <源节点> <workspace:w/rel> --out <本地目标路径>');
      process.exit(2);
    }
    if (!wsRelOf(wsRef)) { console.error(`workspace 引用须形如 workspace:repo/dist/a.bin（相对路径不得含 .. 或空段），实得 ${wsRef}`); process.exit(2); }
    const conn = resolveConn({ hub: argOf(rest, '--hub'), token: argOf(rest, '--token'), tokenFile: argOf(rest, '--token-file') });
    const oc = outcomeOf(await callMcp(conn, 'transfer_fetch', { node, path: wsRef }));
    let inboxSha = oc.file_sha256;
    if (out) {
      // 收件箱在 hub 宿主侧——--out 复制只对 hub 宿主形态有意义；节点形态请用 transfer_push 直达
      if (!oc.inbox_path || !fs.existsSync(oc.inbox_path)) {
        console.error(`[mdp file] --out 需在 hub 宿主侧执行（收件箱 ${oc.inbox_path} 本机不可见）`);
        process.exit(1);
      }
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.copyFileSync(oc.inbox_path, out);
      inboxSha = sha256File(out);
    }
    const ok = inboxSha === oc.file_sha256;
    console.log(`[mdp file] pull ${ok ? 'ok' : 'SHA 不一致!'}：node=${node} path=${wsRef} transfer_id=${oc.transfer_id}`);
    console.log(`sha256=${oc.file_sha256} bytes=${oc.bytes}${out ? ` → ${path.resolve(out)}（落盘=${inboxSha}）` : ` → ${oc.inbox_path}`}`);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  console.error('用法：mdp file <stash|push|pull> …（--help 见 apps/cli/src/file.ts 头注）');
  process.exit(2);
};
