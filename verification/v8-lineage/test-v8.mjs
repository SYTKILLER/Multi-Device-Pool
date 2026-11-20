// V8 · P2-2 验收：superseded 签发语义全链。
// 场景：同机 hub + 0.3.0 节点。覆盖：
//   migrate fetch → 源副本 manifest superseded=true（nodes() 可见）+ hub db 血统记录同步 /
//   superseded 后写类操作信封带强警告（放行不阻塞，01 §5.2）/ 非 migrate fetch 源不动 /
//   push 带 migrate 明确拒绝 / workspace_unsupersede 清标记后警告消失。
// 运行：node verification/v8-lineage/test-v8.mjs（前置：npm run build）
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

process.on('uncaughtException', (e) => {
  console.error(`\n[UNCAUGHT] ${e.stack ?? e}`);
  console.log('--- hub 日志尾部 ---');
  console.log(hubLog.slice(-20).join('\n'));
  console.log('--- node 日志尾部 ---');
  console.log(nodeLog.slice(-20).join('\n'));
  try { nodeProc.kill(); hubProc.kill(); } catch { /* 已死 */ }
  process.exit(2);
});

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-v8-'));
const hubHome = path.join(work, 'hub');
const nodeHome = path.join(work, 'node');
const fixture = path.join(work, 'repo');
fs.mkdirSync(path.join(fixture, 'dist'), { recursive: true });
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

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
const hubLog = [];
hubProc.stdout.on('data', (c) => hubLog.push(...c.toString().split('\n').filter(Boolean)));
hubProc.stderr.on('data', (c) => hubLog.push('[hub:stderr] ' + c.toString().trim()));
let info;
for (let i = 0; i < 50; i++) {
  await sleep(100);
  try { info = JSON.parse(fs.readFileSync(path.join(hubHome, 'hub-info.json'), 'utf8')); break; } catch { /* 未就绪 */ }
}
if (!info) { console.error('FATAL hub 未启动'); hubProc.kill(); process.exit(1); }

const cfg = { display_name: 'pc-t8', hub: `127.0.0.1:${info.node_port}`, workspaces: [{ name: 'repo', path: fixture }] };
fs.mkdirSync(nodeHome, { recursive: true });
fs.writeFileSync(path.join(nodeHome, 'config.json'), JSON.stringify(cfg));
const nodeProc = spawn(process.execPath, [nodeBin, '--home', nodeHome, '--config', path.join(nodeHome, 'config.json')], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const nodeLog = [];
nodeProc.stdout.on('data', (c) => nodeLog.push(...c.toString().split('\n').filter(Boolean)));
nodeProc.stderr.on('data', (c) => nodeLog.push('[node:stderr] ' + c.toString().trim()));

const callTool = async (name, args) => {
  const res = await fetch(`http://127.0.0.1:${info.mcp_port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return JSON.parse((await res.json()).result.content[0].text);
};
const wsState = async () => {
  const n = JSON.parse((await callTool('nodes', {})).result.stdout);
  return n.nodes.find((x) => x.display_name === 'pc-t8')?.workspaces?.[0];
};

let online = false;
for (let i = 0; i < 150; i++) {
  await sleep(100);
  try { if ((await wsState())?.online !== undefined || (await callTool('nodes', {})).result) { online = true; break; } } catch { /* 未就绪 */ }
}
ok('T0 节点入池', online);

// ---------- T1 非 migrate fetch：源副本不动 ----------
const src1 = path.join(work, 'a.bin');
fs.writeFileSync(src1, Buffer.alloc(5000, 7));
const p1 = await callTool('transfer_push', { node: 'pc-t8', src: src1, path: 'workspace:repo/dist/a.bin' });
ok('T1a push 就绪', p1.status === 'ok', JSON.stringify(p1).slice(0, 200));
const f1 = await callTool('transfer_fetch', { node: 'pc-t8', path: 'workspace:repo/dist/a.bin' });
ok('T1b fetch ok', f1.status === 'ok', JSON.stringify(f1).slice(0, 200));
ok('T1c 非 migrate fetch 后源副本未让位', (await wsState())?.superseded === false, JSON.stringify(await wsState()));

// ---------- T2 migrate fetch：源副本让位 ----------
const f2 = await callTool('transfer_fetch', { node: 'pc-t8', path: 'workspace:repo/dist/a.bin', migrate: true });
ok('T2a migrate fetch ok', f2.status === 'ok', JSON.stringify(f2).slice(0, 200));
// 节点重报 manifest 是异步帧——轮询直至可见（≤5s）
let sup = false;
for (let i = 0; i < 50; i++) { await sleep(100); if ((await wsState())?.superseded === true) { sup = true; break; } }
ok('T2b migrate 后源副本 superseded=true（manifest 重报）', sup, JSON.stringify(await wsState()));
const db = JSON.parse(fs.readFileSync(path.join(hubHome, 'hub.db.json'), 'utf8'));
ok('T2c hub db 血统记录同步 superseded', Object.values(db.lineage ?? {}).some((r) => r.superseded === true), JSON.stringify(db.lineage ?? {}).slice(0, 200));

// ---------- T3 superseded 后写类操作：放行 + 强警告 ----------
const w1 = await callTool('fs', { node: 'pc-t8', op: 'write', path: 'workspace:repo/dist/warned.txt', content: '写入已让位副本' });
ok('T3a fs write 放行（不阻塞）', w1.status === 'ok', JSON.stringify(w1).slice(0, 200));
ok('T3b 信封带 superseded 强警告', Array.isArray(w1.warnings) && w1.warnings.some((w) => w.includes('superseded')), JSON.stringify(w1.warnings));
const e1 = await callTool('exec', { node: 'pc-t8', cmd: 'Write-Output hi', cwd: 'workspace:repo' });
ok('T3c exec 写域操作同样带警告', e1.status === 'ok' && Array.isArray(e1.warnings) && e1.warnings.some((w) => w.includes('superseded')), JSON.stringify({ s: e1.status, w: e1.warnings }));
const r1 = await callTool('fs', { node: 'pc-t8', op: 'read', path: 'workspace:repo/dist/a.bin' });
ok('T3d 读类操作不告警', r1.status === 'ok' && !r1.warnings?.length, JSON.stringify(r1.warnings));

// ---------- T4 push 带 migrate 明确拒绝 ----------
const p4 = await callTool('transfer_push', { node: 'pc-t8', src: src1, path: 'workspace:repo/dist/x.bin', migrate: true });
ok('T4 push migrate 明确拒绝', p4.status === 'failed' && String(p4.error?.message).includes('不支持 migrate'), JSON.stringify(p4).slice(0, 240));

// ---------- T5 workspace_unsupersede 清标记 ----------
const u1 = await callTool('workspace_unsupersede', { node: 'pc-t8', workspace: 'repo' });
ok('T5a 清标记 ok', u1.status === 'ok', JSON.stringify(u1).slice(0, 200));
let cleared = false;
for (let i = 0; i < 50; i++) { await sleep(100); if ((await wsState())?.superseded === false) { cleared = true; break; } }
ok('T5b manifest 重报 superseded=false', cleared, JSON.stringify(await wsState()));
const w2 = await callTool('fs', { node: 'pc-t8', op: 'write', path: 'workspace:repo/dist/after-clear.txt', content: '清标记后写入' });
ok('T5c 清标记后写不再告警', w2.status === 'ok' && !w2.warnings?.length, JSON.stringify(w2.warnings));
const u2 = await callTool('workspace_unsupersede', { node: 'pc-t8', workspace: 'repo' });
ok('T5d 未标记时幂等报错', u2.status === 'failed', JSON.stringify(u2).slice(0, 200));

// ---------- teardown ----------
hubProc.kill();
nodeProc.kill();
console.log(`\n===== V8 结果：${passed} PASS / ${failed} FAIL =====`);
process.exit(failed ? 1 : 0);
