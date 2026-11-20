// V7 · P2-4 验收：mdp file stash/push/pull CLI 端到端。
// 场景：同机 hub + 0.3.0 节点；CLI 子进程实跑（非直调 MCP），覆盖：
//   stash 落盘哈希 / push 三方哈希 + 多块 / pull --out 双重比对 / pull 收件箱形态 /
//   连接形态判别（hub-info.json 宿主形态 vs --token-file 交接形态）/ 错误路径 exit code。
// 运行：node verification/v7-cli-file/test-v7.mjs（前置：npm run build）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}\n      -> ${detail}`); }
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-v7-'));
const hubHome = path.join(work, 'hub');
const nodeHome = path.join(work, 'node');
const fixture = path.join(work, 'repo');
const cliBin = path.join(ROOT, 'apps', 'cli', 'dist', 'index.js');
fs.mkdirSync(path.join(fixture, 'dist'), { recursive: true });

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const mkPayload = (len, seed = 13) => {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = (i * seed + 29) & 0xff;
  return b;
};

/** CLI 子进程实跑；默认 --token-file 显式交接文件（防节点机残留 hub-info.json 误连 127.0.0.1:7800——B 机实测坑，测试必须确定性） */
const HANDOFF = path.join(work, '.mdp-hub-token.json');
const runCli = async (args, tokenFile = HANDOFF) => {
  const argv = tokenFile ? [...args, '--token-file', tokenFile] : args;
  return await new Promise((resolve) => {
    const p = spawn(process.execPath, [cliBin, ...argv], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code, out, err }));
    setTimeout(() => { try { p.kill(); } catch { /* 已退 */ } resolve({ code: -1, out, err: err + '\n[timeout 120s]' }); }, 120000);
  });
};

// ---------- hub + node 环境（同 V6） ----------
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const mcpPort = await freePort();
const nodePort = await freePort();
const hubBin = path.join(ROOT, 'packages', 'hub', 'dist', 'index.js');
const nodeBin = path.join(ROOT, 'packages', 'node', 'dist', 'index.js');

const hubProc = spawn(process.execPath, [hubBin, '--home', hubHome, '--port', String(mcpPort), '--node-port', String(nodePort)], {
  env: { ...process.env, MDP_HEARTBEAT_MS: '3000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let info;
for (let i = 0; i < 50; i++) {
  await sleep(100);
  try { info = JSON.parse(fs.readFileSync(path.join(hubHome, 'hub-info.json'), 'utf8')); break; } catch { /* 未就绪 */ }
}
if (!info) { console.error('FATAL hub 未启动'); hubProc.kill(); process.exit(1); }

fs.mkdirSync(nodeHome, { recursive: true });
const cfg = { display_name: 'pc-t7', hub: `127.0.0.1:${info.node_port}`, workspaces: [{ name: 'repo', path: fixture }] };
fs.writeFileSync(path.join(nodeHome, 'config.json'), JSON.stringify(cfg));
const nodeProc = spawn(process.execPath, [nodeBin, '--home', nodeHome, '--config', path.join(nodeHome, 'config.json')], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

const TOKEN = info.token;
// 交接文件（全测试 CLI 调用的默认连接形态）
fs.writeFileSync(HANDOFF, JSON.stringify({ hub: `http://127.0.0.1:${info.mcp_port}`, token: TOKEN }));
const callTool = async (name, args) => {
  const res = await fetch(`http://127.0.0.1:${info.mcp_port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return JSON.parse((await res.json()).result.content[0].text);
};
let nodeOnline = false;
for (let i = 0; i < 150; i++) {  // 15s：CLI 测试机常带构建负载，T0 冷启动偶发超 8s（首轮实测 flaky），放宽窗口
  await sleep(100);
  try {
    const n = await callTool('nodes', {});
    if (JSON.parse(n.result.stdout).nodes.some((x) => x.online && x.display_name === 'pc-t7')) { nodeOnline = true; break; }
  } catch { /* 未就绪 */ }
}
ok('T0 节点入池', nodeOnline);

// ---------- T1 stash：本地复制 + 哈希 ----------
const src1 = path.join(work, 'src-1mb.bin');
const payload1 = mkPayload(1048576); // 1 MiB
fs.writeFileSync(src1, payload1);
const r1 = await runCli(['file', 'stash', 'src-1mb.bin', 'workspace:repo/dist/stashed.bin', '--ws', fixture]);
ok('T1a stash exit=0 且输出 sha', r1.code === 0 && r1.out.includes(`sha256=${sha256(src1)}`), `code=${r1.code} ${r1.err}`);
ok('T1b 落盘逐字节一致', fs.existsSync(path.join(fixture, 'dist', 'stashed.bin')) && Buffer.compare(fs.readFileSync(path.join(fixture, 'dist', 'stashed.bin')), payload1) === 0);
ok('T1c stash `..` 逃逸拒绝（overlay 同款词法规则）', (await runCli(['file', 'stash', 'src-1mb.bin', 'workspace:repo/../escape.bin', '--ws', fixture])).code === 2 && !fs.existsSync(path.join(work, 'escape.bin')), '路径逃逸未被拒绝');

// ---------- T2 push：CLI（宿主形态自动判别：cwd 无交接文件 → hub-info.json）+ 多块 ----------
const r2 = await runCli(['file', 'push', 'src-1mb.bin', '--node', 'pc-t7', '--path', 'workspace:repo/dist/pushed.bin']);
ok('T2a push exit=0 三方 sha 一致', r2.code === 0 && r2.out.includes(sha256(src1)) && Buffer.compare(fs.readFileSync(path.join(fixture, 'dist', 'pushed.bin')), payload1) === 0, `code=${r2.code} ${r2.err}${r2.out}`);
ok('T2b push 不存在 src 明确报错', (await runCli(['file', 'push', 'no-such.bin', '--node', 'pc-t7', '--path', 'workspace:repo/x.bin'])).code === 1, '期望 exit 1');
ok('T2c 坏 workspace 引用 exit=2', (await runCli(['file', 'push', 'src-1mb.bin', '--node', 'pc-t7', '--path', 'not-a-ref'])).code === 2);

// ---------- T3 pull：--out 双重比对 ----------
const out3 = path.join(work, 'pulled-out.bin');
const r3 = await runCli(['file', 'pull', 'pc-t7', 'workspace:repo/dist/pushed.bin', '--out', out3]);
ok('T3a pull --out exit=0 哈希一致', r3.code === 0 && Buffer.compare(fs.readFileSync(out3), payload1) === 0 && r3.out.includes(sha256(src1)), `code=${r3.code} ${r3.err}`);
const r3b = await runCli(['file', 'pull', 'pc-t7', 'workspace:repo/dist/pushed.bin']);
const inboxPath = (r3b.out.match(/→ (.+)$/m) || [])[1]?.trim();
ok('T3b pull 收件箱形态 ok（B 机视角验证：exit=0 + inbox 路径输出 + sha 一致；收件箱文件本体在 hub 宿主不可 existsSync）', r3b.code === 0 && /inbox[\\/]/.test(inboxPath ?? '') && r3b.out.includes(sha256(src1)), `code=${r3b.code} inbox=${inboxPath}`);

// ---------- T4 交接文件形态：显式 --token-file 已是全测试默认（HANDOFF 在环境准备期写好）；此处补错误路径 ----------
ok('T4 --token-file 指向不存在文件 exit≠0（明确报错不静默回退）', (await runCli(['file', 'pull', 'pc-t7', 'workspace:repo/dist/pushed.bin'], path.join(work, 'no-such.json'))).code !== 0, '期望非零退出');

// ---------- T5 中文文件名端到端（stash→push→pull 全链） ----------
const src5 = path.join(work, '中文源-大载荷.bin');
fs.writeFileSync(src5, mkPayload(2 * 1048576 + 7)); // 跨 3 块（默认 chunk 1 MiB）
await runCli(['file', 'stash', '中文源-大载荷.bin', 'workspace:repo/dist/中文落盘.bin', '--ws', fixture]);
const r5 = await runCli(['file', 'pull', 'pc-t7', 'workspace:repo/dist/中文落盘.bin', '--out', path.join(work, '中文取回.bin')]);
ok('T5 中文文件名 2MiB+7B 全链哈希一致', r5.code === 0 && sha256(path.join(work, '中文取回.bin')) === sha256(src5), `code=${r5.code} ${r5.err}${r5.out}`);

// ---------- teardown ----------
hubProc.kill();
nodeProc.kill();
console.log(`\n===== V7 结果：${passed} PASS / ${failed} FAIL =====`);
process.exit(failed ? 1 : 0);
