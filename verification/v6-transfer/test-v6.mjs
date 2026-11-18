// V6 · P2-1 接线验收：transfer 走混合帧（JSON 控制行 + t:'bin' 定长二进制块）端到端。
// 场景：同机 hub + 0.3.0 节点（全字节二进制净荷 / 中文文件名 / 差量语义 / 版本闸 / overlay 闸 / 空文件 / 血统）。
// 环境：MDP_TRANSFER_MAX_BYTES=16384（压小上限供越限测试），transfer_push 用 chunk_size=4096 取多块流。
// 运行：node verification/v6-transfer/test-v6.mjs
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

// ---------- 环境准备 ----------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-v6-'));
const hubHome = path.join(work, 'hub');
const nodeHome = path.join(work, 'node');
const fixture = path.join(work, 'repo');
fs.mkdirSync(path.join(fixture, '.git'), { recursive: true });
fs.mkdirSync(path.join(fixture, 'dist'), { recursive: true });

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const mkPayload = (len, seed = 7) => {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = (i * seed + 11) & 0xff;
  return b;
};
/** 二进制透明性载荷：全 256 字节值 × N + 形似帧头/哨兵的恶意内容 */
const mkBinaryTricky = () => {
  const parts = [];
  for (let round = 0; round < 16; round++) for (let i = 0; i < 256; i++) parts.push(i); // 4096 字节全值覆盖
  parts.push(...Buffer.from('\n{"t":"bin","stream":"evil","bytes":999999}\n', 'utf8'));
  parts.push(...Buffer.from('x'.repeat(10) + '\n' + 'y'.repeat(10), 'utf8'));
  return Buffer.from(parts);
};

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const mcpPort = await freePort();
const nodePort = await freePort();

const hubBin = path.join(ROOT, 'packages', 'hub', 'dist', 'index.js');
const nodeBin = path.join(ROOT, 'packages', 'node', 'dist', 'index.js');

const hubProc = spawn(process.execPath, [hubBin, '--home', hubHome, '--port', String(mcpPort), '--node-port', String(nodePort)], {
  env: { ...process.env, MDP_TRANSFER_MAX_BYTES: '16384', MDP_HEARTBEAT_MS: '3000', MDP_AUDIT_PULL_MS: '1000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const hubLog = [];
hubProc.stdout.on('data', (c) => hubLog.push(...c.toString().split('\n').filter(Boolean)));

let info;
for (let i = 0; i < 50; i++) {
  await sleep(100);
  try { info = JSON.parse(fs.readFileSync(path.join(hubHome, 'hub-info.json'), 'utf8')); break; } catch { /* 未就绪 */ }
}
if (!info) { console.error('FATAL hub 未启动'); hubProc.kill(); process.exit(1); }
const TOKEN = info.token;
const MCP = `http://127.0.0.1:${info.mcp_port}`;

const callTool = async (name, args) => {
  const res = await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  return JSON.parse(body.result.content[0].text);
};

const t0 = Date.now();
const ts = () => `+${Date.now() - t0}ms`;
const startNode = (home, name, agentVersion) => {
  fs.mkdirSync(home, { recursive: true });
  const cfg = { display_name: name, hub: `127.0.0.1:${info.node_port}`, workspaces: [{ name: 'repo', path: fixture }] };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
  return spawn(process.execPath, [nodeBin, '--home', home, '--config', path.join(home, 'config.json')], {
    env: agentVersion ? { ...process.env, MDP_AGENT_VERSION: agentVersion } : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};
const nodeLog = [];
let nodeProc = startNode(nodeHome, 'pc-t6');
nodeProc.stdout.on('data', (c) => nodeLog.push(...c.toString().split('\n').filter(Boolean)));
nodeProc.stderr.on('data', (c) => nodeLog.push(...c.toString().split('\n').filter(Boolean)));
console.log(`${ts()} hub@${MCP} node端口${info.node_port}，节点已 spawn（transfer 上限 16384B，chunk_size=4096）`);

let nodeOnline = false;
for (let i = 0; i < 80; i++) {
  await sleep(100);
  try {
    const n = await callTool('nodes', {});
    if (JSON.parse(n.result.stdout).nodes.some((x) => x.online && x.display_name === 'pc-t6')) { nodeOnline = true; break; }
  } catch { /* 未就绪 */ }
}
ok('T0 节点入池', nodeOnline, '80×100ms 内未见 pc-t6 online');

// ---------- T1 push：中文文件名 + 多块 + sha 双侧一致 + 血统 revision 递增 ----------
const src1 = path.join(work, '中文源文件.bin');
const payload1 = mkPayload(10000); // 3 块（chunk_size 4096）
fs.writeFileSync(src1, payload1);
const p1 = await callTool('transfer_push', { node: 'pc-t6', src: src1, path: 'workspace:repo/dist/中文目标.bin', chunk_size: 4096 });
const o1 = p1.status === 'ok' ? JSON.parse(p1.result.stdout) : null;
ok('T1a push ok + sha/bytes/chunks', p1.status === 'ok' && o1?.file_sha256 === sha256(src1) && o1?.bytes === 10000 && o1?.chunks === 3, JSON.stringify(p1).slice(0, 240));
ok('T1b 目标文件逐字节一致', fs.existsSync(path.join(fixture, 'dist', '中文目标.bin')) && Buffer.compare(fs.readFileSync(path.join(fixture, 'dist', '中文目标.bin')), payload1) === 0, '字节不一致或未落地');
ok('T1c staging/状态清理', !fs.existsSync(path.join(fixture, 'dist', '中文目标.bin.mdp-part')) && !fs.existsSync(path.join(fixture, 'dist', '中文目标.bin.mdp-part.json')), '残留 staging');
let nodesSnap = JSON.parse((await callTool('nodes', {})).result.stdout);
const ws1 = nodesSnap.nodes.find((n) => n.online)?.workspaces?.[0];
ok('T1d 血统 revision 递增（manifest 重报）', Number(ws1?.revision) >= 1, `revision=${ws1?.revision}`);
const db = JSON.parse(fs.readFileSync(path.join(hubHome, 'hub.db.json'), 'utf8'));
ok('T1e hub 血统持久化', Object.values(db.lineage ?? {}).some((r) => r.origin === 'push' && r.file_sha256 === o1?.file_sha256), JSON.stringify(db.lineage ?? {}).slice(0, 160));

// ---------- T2 二进制透明性：全字节值 + 形似帧内容 ----------
const src2 = path.join(work, 'binary-tricky.bin');
const payload2 = mkBinaryTricky();
fs.writeFileSync(src2, payload2);
const p2 = await callTool('transfer_push', { node: 'pc-t6', src: src2, path: 'workspace:repo/dist/tricky.bin', chunk_size: 4096 });
const o2 = p2.status === 'ok' ? JSON.parse(p2.result.stdout) : null;
ok('T2a push 形似帧内容净荷 ok', p2.status === 'ok' && o2?.file_sha256 === sha256(src2), JSON.stringify(p2).slice(0, 200));
ok('T2b 净荷逐字节一致', Buffer.compare(fs.readFileSync(path.join(fixture, 'dist', 'tricky.bin')), payload2) === 0, '字节不一致');

// ---------- T3 fetch：节点 → hub 收件箱 ----------
const f1 = await callTool('transfer_fetch', { node: 'pc-t6', path: 'workspace:repo/dist/tricky.bin' });
const of1 = f1.status === 'ok' ? JSON.parse(f1.result.stdout) : null;
ok('T3a fetch ok + inbox_path + sha', f1.status === 'ok' && of1?.inbox_path && of1.file_sha256 === sha256(src2), JSON.stringify(f1).slice(0, 240));
ok('T3b 收件箱逐字节一致', of1?.inbox_path && Buffer.compare(fs.readFileSync(of1.inbox_path), payload2) === 0, '收件箱字节不一致');

// ---------- T4 越限拒绝 ----------
const big = path.join(work, 'big.bin');
fs.writeFileSync(big, mkPayload(32768)); // 32KB > 16KB cap
const p4 = await callTool('transfer_push', { node: 'pc-t6', src: big, path: 'workspace:repo/dist/big.bin' });
ok('T4 超上限 deny（永不重试）', p4.status === 'failed' && /上限/.test(p4.error?.message ?? '') && p4.error?.retryable === false, JSON.stringify(p4).slice(0, 200));

// ---------- T5 旧版本节点：版本协商闸 ----------
const nodeHome2 = path.join(work, 'node-old');
let oldProc = startNode(nodeHome2, 'pc-old', '0.2.0');
let oldOnline = false;
for (let i = 0; i < 80; i++) {
  await sleep(100);
  try {
    const n = await callTool('nodes', {});
    if (JSON.parse(n.result.stdout).nodes.some((x) => x.online && x.display_name === 'pc-old')) { oldOnline = true; break; }
  } catch { /* 未就绪 */ }
}
ok('T5a 旧节点入池', oldOnline, 'pc-old 未上线');
const p5 = await callTool('transfer_push', { node: 'pc-old', src: src1, path: 'workspace:repo/dist/old.bin', chunk_size: 4096 });
ok('T5b 旧 agent transfer 被版本协商拒绝', p5.status === 'failed' && /版本协商|0\.3\.0/.test(p5.error?.message ?? ''), JSON.stringify(p5).slice(0, 200));
oldProc.kill();

// ---------- T6 空文件双向 ----------
const empty = path.join(work, 'empty.bin');
fs.writeFileSync(empty, '');
const p6 = await callTool('transfer_push', { node: 'pc-t6', src: empty, path: 'workspace:repo/dist/empty-push.bin', chunk_size: 4096 });
const o6 = p6.status === 'ok' ? JSON.parse(p6.result.stdout) : null;
ok('T6a 空文件 push', p6.status === 'ok' && o6?.bytes === 0 && o6?.chunks === 0 && fs.existsSync(path.join(fixture, 'dist', 'empty-push.bin')), JSON.stringify(p6).slice(0, 200));
const f6 = await callTool('transfer_fetch', { node: 'pc-t6', path: 'workspace:repo/dist/empty-push.bin' });
const of6 = f6.status === 'ok' ? JSON.parse(f6.result.stdout) : null;
ok('T6b 空文件 fetch', f6.status === 'ok' && of6?.bytes === 0 && of6?.inbox_path && fs.existsSync(of6.inbox_path), JSON.stringify(f6).slice(0, 200));

// ---------- T7 目标子目录不存在 → 自动建目录 ----------
const p7 = await callTool('transfer_push', { node: 'pc-t6', src: src1, path: 'workspace:repo/nested/deeper/made-by-transfer.bin', chunk_size: 4096 });
ok('T7 push 建父目录', p7.status === 'ok' && Buffer.compare(fs.readFileSync(path.join(fixture, 'nested', 'deeper', 'made-by-transfer.bin')), payload1) === 0, JSON.stringify(p7).slice(0, 200));

// ---------- T8 overlay transfer=deny：闸生效（经 hub REST PATCH /nodes/:id/overlay） ----------
nodesSnap = JSON.parse((await callTool('nodes', {})).result.stdout);
const t6id = nodesSnap.nodes.find((n) => n.display_name === 'pc-t6')?.node_id;
const pr = await fetch(`${MCP}/nodes/${t6id}/overlay`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ levels: { transfer: 'deny' } }),
});
await sleep(300); // 推送即时生效
const p8 = await callTool('transfer_push', { node: 'pc-t6', src: src1, path: 'workspace:repo/dist/denied.bin', chunk_size: 4096 });
ok('T8 overlay transfer=deny → 拒绝', pr.status === 200 && p8.status === 'denied' && /overlay/.test(p8.error?.message ?? ''), `${pr.status} ${JSON.stringify(p8).slice(0, 200)}`);
await fetch(`${MCP}/nodes/${t6id}/overlay`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ levels: { transfer: 'workspaces' } }),
});

// ---------- T9 audit 链含 transfer 记录 ----------
await sleep(1500); // 等审计锚定拉取
const db9 = JSON.parse(fs.readFileSync(path.join(hubHome, 'hub.db.json'), 'utf8'));
const aud9 = db9.audit?.[Object.keys(db9.nodes ?? {}).find((id) => db9.nodes[id].manifest.display_name === 'pc-t6') ?? ''];
ok('T9 审计锚定含 transfer receive/send', (aud9?.recent ?? []).some((r) => r.kind === 'transfer' && r.op === 'receive') && (aud9?.recent ?? []).some((r) => r.kind === 'transfer' && r.op === 'send'), JSON.stringify(aud9?.recent ?? []).slice(0, 240));

// ---------- 汇总 ----------
console.log(`\n===== V6 结果：${passed} PASS / ${failed} FAIL =====`);
if (failed > 0) {
  console.log('--- hub 日志尾部 ---');
  console.log(hubLog.slice(-15).join('\n'));
  console.log('--- node 日志尾部 ---');
  console.log(nodeLog.slice(-15).join('\n'));
}
nodeProc.kill();
hubProc.kill();
process.exit(failed > 0 ? 1 : 0);
