// V5 · hub/node 最小版集成验收（P0 后半段，01 技术方案 §10 P0 验收行）
// 场景：同机双进程（hub daemon + node agent）+ 双 MCP 客户端并挂（V5 会话隔离/审批合并的池层代理）。
// 覆盖：静态基线工具面、exec/fs 全链路（含 V2 UTF-8 通路）、失败信封全分类
//       （ok/timeout/denied/needs_approval+审批/审批 TTL 到期/busy/offline/unknown+对账/crash）、
//       后台 job（submit/status/output/cancel）、attach 桥。
// 运行：node verification/v5-hub/test-v5.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}\n      -> ${detail}`); }
};

// ---------- 环境准备 ----------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-v5-'));
const hubHome = path.join(work, 'hub');
const nodeHome = path.join(work, 'node');
const fixture = path.join(work, 'repo');
fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
fs.mkdirSync(path.join(fixture, '.git'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'src', 'app.py'), 'print("hello mdp")\n# TODO 标记\n');
fs.writeFileSync(path.join(fixture, '中文说明.txt'), '这是中文内容-abc123\n');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const mcpPort = await freePort();
const nodePort = await freePort();

const hubBin = path.join(ROOT, 'packages', 'hub', 'dist', 'index.js');
const nodeBin = path.join(ROOT, 'packages', 'node', 'dist', 'index.js');

const hubProc = spawn(process.execPath, [hubBin, '--home', hubHome, '--port', String(mcpPort), '--node-port', String(nodePort)], {
  env: { ...process.env, MDP_APPROVAL_TTL_MS: '4000', MDP_TTL_SWEEP_MS: '500', MDP_HEARTBEAT_MS: '3000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const hubLog = [];
hubProc.stdout.on('data', (c) => hubLog.push(...c.toString().split('\n').filter(Boolean)));

// 等 hub-info.json
let info;
for (let i = 0; i < 50; i++) {
  await sleep(100);
  try { info = JSON.parse(fs.readFileSync(path.join(hubHome, 'hub-info.json'), 'utf8')); break; } catch { /* 未就绪 */ }
}
if (!info) { console.error('FATAL hub 未启动'); hubProc.kill(); process.exit(1); }

const TOKEN = info.token;
const MCP = `http://127.0.0.1:${info.mcp_port}`;

// MCP 客户端（最小 JSON-RPC over HTTP，带令牌；两实例即两"会话"）
const callRpc = async (method, params, { client = 'A', expectError = false } = {}) => {
  const res = await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'X-Mdp-Client': client },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params }),
  });
  const body = await res.json();
  if (expectError) return body;
  if (body.error) throw new Error(`RPC ${method} 失败: ${JSON.stringify(body.error)}`);
  return body.result;
};
const callTool = async (name, args, opts) => {
  const r = await callRpc('tools/call', { name, arguments: args }, opts);
  return JSON.parse(r.content[0].text);
};
const rest = async (p, method = 'POST') => {
  const res = await fetch(`${MCP}${p}`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: await res.json() };
};

/** 轮询 job 直至终态（finished/denied/expired/cancelled）或超时 */
const waitForJob = async (jobId, { client = 'A', timeoutMs = 8000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await callTool('job_status', { job_id: jobId }, { client });
    const body = JSON.parse(s.result.stdout);
    if (['finished', 'denied', 'expired', 'cancelled'].includes(body.state)) return body;
    await sleep(200);
  }
  return { state: 'poll-timeout' };
};

const t0 = Date.now();
const ts = () => `+${Date.now() - t0}ms`;
const startNode = () => {
  fs.mkdirSync(nodeHome, { recursive: true });
  const cfg = { display_name: 'pc-test', hub: `127.0.0.1:${info.node_port}`, workspaces: [{ name: 'repo', path: fixture }] };
  fs.writeFileSync(path.join(nodeHome, 'config.json'), JSON.stringify(cfg));
  const p = spawn(process.execPath, [nodeBin, '--home', nodeHome, '--config', path.join(nodeHome, 'config.json')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onLine = (c) => { for (const l of c.toString().split('\n')) if (l.trim()) nodeLog.push(`${ts()} ${l.trim()}`); };
  p.stdout.on('data', onLine);
  p.stderr.on('data', onLine);
  return p;
};
const nodeLog = [];
let nodeProc = startNode();
console.log(`${ts()} hub@${MCP} node端口${info.node_port}，node 已 spawn`);

// 等节点上线
let nodeOnline = false;
for (let i = 0; i < 80; i++) {
  await sleep(100);
  try {
    const { body } = await rest('/nodes', 'GET');
    if (body.nodes?.some((n) => n.online)) { nodeOnline = true; break; }
  } catch { /* hub 未就绪 */ }
}
ok(`T0 双进程起：node agent 已注册到 hub（耗时 ${ts()}）`, nodeOnline, hubLog.join('\n') + '\n[node log]\n' + nodeLog.join('\n'));

// ---------- 初始化两个 MCP 会话 ----------
const initA = await callRpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'client-A', version: '0' } });
ok('T1 initialize：serverInfo=mdp', initA.serverInfo?.name === 'mdp', JSON.stringify(initA));

// ---------- 工具面 ----------
const tools = (await callRpc('tools/list', {})).tools;
ok('T2 静态基线 7 工具（01 §4.1）', ['nodes', 'exec', 'fs', 'job_submit', 'job_status', 'job_output', 'job_cancel'].every((n) => tools.some((t) => t.name === n)) && tools.length === 7,
  `tools=${tools.map((t) => t.name).join(',')}`);

const nodes = await callTool('nodes', {});
const pc = nodes.result ? JSON.parse(nodes.result.stdout).nodes.find((n) => n.display_name === 'pc-test') : undefined;
ok('T3 nodes()：manifest 摘要（工作区/能力/shell）', !!pc && pc.workspaces.some((w) => w.name === 'repo') && pc.shell === 'powershell' && pc.native_enforcement === 'none',
  JSON.stringify(nodes).slice(0, 300));
const NODE_ID = pc?.node_id;

// ---------- exec：ok + UTF-8（V2 通路端到端） ----------
const e1 = await callTool('exec', { node: 'pc-test', cmd: `Write-Output '中文OK-123'`, cwd: 'workspace:repo' });
ok('T4 exec ok：exit=0 且 stdout UTF-8 中文无乱码', e1.status === 'ok' && e1.result.exit === 0 && e1.result.stdout.includes('中文OK-123'), JSON.stringify(e1).slice(0, 300));
ok('T5 信封字段：node_id/call_id/ts_hub（hub 签发时间戳）', e1.node_id === NODE_ID && /^c-/.test(e1.call_id) && Math.abs(e1.ts_hub - Date.now()) < 60000, JSON.stringify({ node_id: e1.node_id, call_id: e1.call_id, ts_hub: e1.ts_hub }));

// stderr 路径 UTF-8（V2 双路验证的端到端：cmd 内部命令重定向 stderr）
const e2 = await callTool('exec', { node: 'pc-test', cmd: `cmd /c "echo 中文ERR-456 1>&2"`, cwd: 'workspace:repo' });
ok('T6 exec stderr UTF-8 双路', e2.status === 'ok' && e2.result.stderr.includes('中文ERR-456'), JSON.stringify(e2.result ?? {}).slice(0, 200));

// 退出码透传
const e3 = await callTool('exec', { node: 'pc-test', cmd: `exit 7`, cwd: 'workspace:repo' });
ok('T7 exec 非零退出码透传（status=ok, exit=7）', e3.status === 'ok' && e3.result.exit === 7, JSON.stringify(e3.result ?? {}));

// ---------- 失败信封分类 ----------
// timeout
const e4 = await callTool('exec', { node: 'pc-test', cmd: `Start-Sleep -Seconds 8`, cwd: 'workspace:repo', timeout_ms: 1500 });
ok('T8 timeout 信封：class=timeout', e4.status === 'timeout' && e4.error?.class === 'timeout', JSON.stringify(e4).slice(0, 300));

// denied（overlay 路径域：cwd 超出工作区 → 确定性拒绝，永不重试）
const e5 = await callTool('exec', { node: 'pc-test', cmd: `Write-Output 'should-not-run'`, cwd: 'C:/Windows' });
ok('T9 denied：cwd 越界 → class=permission 永不重试（命令未执行）', e5.status === 'denied' && e5.error?.class === 'permission' && e5.error.retryable === false && /工作区|overlay/.test(e5.error.message) && !e5.result, JSON.stringify(e5).slice(0, 300));

// crash（shell 本身不存在 → spawn ENOENT）
const e6 = await callTool('exec', { node: 'pc-test', cmd: `echo hi`, shell: 'definitely-not-a-shell-xyz', cwd: 'workspace:repo' });
ok('T10 failed：crash 分类（spawn 级失败）', e6.status === 'failed' && e6.error?.class === 'crash', JSON.stringify(e6).slice(0, 300));

// busy（.git/index.lock）
fs.writeFileSync(path.join(fixture, '.git', 'index.lock'), '');
const e7 = await callTool('exec', { node: 'pc-test', cmd: `echo hi`, cwd: 'workspace:repo' });
fs.rmSync(path.join(fixture, '.git', 'index.lock'));
ok('T11 busy：index.lock → class=busy', e7.status === 'failed' && e7.error?.class === 'busy' && /index\.lock/.test(e7.error.message), JSON.stringify(e7).slice(0, 300));

// offline（不存在的节点）
const e8 = await callTool('exec', { node: 'ghost-node', cmd: `echo hi` });
ok('T12 offline：class=offline', e8.status === 'failed' && e8.error?.class === 'offline', JSON.stringify(e8).slice(0, 300));

// ---------- fs 全 op ----------
const f1 = await callTool('fs', { node: 'pc-test', op: 'write', path: 'workspace:repo/out/v5写.txt', content: '写入内容-XYZ987' });
ok('T13 fs write：字节计数', f1.status === 'ok' && JSON.parse(f1.result.stdout).written === Buffer.byteLength('写入内容-XYZ987'), JSON.stringify(f1).slice(0, 200));
const f2 = await callTool('fs', { node: 'pc-test', op: 'read', path: 'workspace:repo/中文说明.txt' });
ok('T14 fs read：中文内容原样', f2.status === 'ok' && f2.result.stdout.includes('这是中文内容-abc123'), JSON.stringify(f2).slice(0, 200));
const f3 = await callTool('fs', { node: 'pc-test', op: 'list', path: 'workspace:repo' });
ok('T15 fs list', f3.status === 'ok' && JSON.parse(f3.result.stdout).some((e) => e.name === 'src'), JSON.stringify(f3).slice(0, 200));
const f4 = await callTool('fs', { node: 'pc-test', op: 'glob', path: 'workspace:repo', glob: '**/*.py' });
ok('T16 fs glob：src/app.py 命中（路径分隔符兼容）', f4.status === 'ok' && JSON.parse(f4.result.stdout).entries.some((e) => /src[\\/]app\.py$/.test(e)),
  JSON.stringify(f4).slice(0, 200));
const f5 = await callTool('fs', { node: 'pc-test', op: 'grep', path: 'workspace:repo', pattern: 'TODO' });
ok('T17 fs grep：命中行号', f5.status === 'ok' && JSON.parse(f5.result.stdout).hits.some((h) => h.line === 2), JSON.stringify(f5).slice(0, 200));
const f6 = await callTool('fs', { node: 'pc-test', op: 'read', path: 'C:/Windows/win.ini' });
ok('T18 fs 越界拒绝：overlay 路径域（permission）', f6.status === 'denied' && f6.error?.class === 'permission', JSON.stringify(f6).slice(0, 200));

// ---------- 审批流：needs_approval → REST 批准 → job_status 终态 ----------
fs.mkdirSync(path.join(work, 'approved-target'), { recursive: true });
fs.mkdirSync(path.join(work, 'merge-target'), { recursive: true });
const a1 = await callTool('exec', { node: 'pc-test', cmd: `Remove-Item -Recurse -Force ${path.join(work, 'approved-target')}`, cwd: 'workspace:repo' });
ok('T19 needs_approval：转 job 返回 job_id', a1.status === 'needs_approval' && /^j-/.test(a1.job?.job_id ?? ''), JSON.stringify(a1).slice(0, 300));
const JOB1 = a1.job?.job_id;
const ap = await rest(`/jobs/${JOB1}/approve`);
const s1 = await waitForJob(JOB1);
ok('T20 批准后续跑完成：state=finished + 结果信封', ap.status === 200 && s1.state === 'finished' && s1.envelope?.status === 'ok', JSON.stringify(s1).slice(0, 300));

// ---------- 审批 TTL 到期默认 deny ----------
const a2 = await callTool('exec', { node: 'pc-test', cmd: `Remove-Item -Recurse -Force ${path.join(work, 'ttl-target')}`, cwd: 'workspace:repo' });
const JOB2 = a2.job?.job_id;
await sleep(5600); // TTL 4s + sweep 0.5s + 余量
const s2 = await callTool('job_status', { job_id: JOB2 });
const s2body = JSON.parse(s2.result.stdout);
ok('T21 TTL 到期默认 deny：state=expired，信封 denied', s2body.state === 'expired' && s2body.envelope?.status === 'denied' && /TTL/.test(s2body.envelope?.error?.message ?? ''), JSON.stringify(s2body).slice(0, 300));

// ---------- 后台 job ----------
const b1 = await callTool('job_submit', { node: 'pc-test', cmd: `for ($i=1; $i -le 3; $i++) { Write-Output "tick-$i"; Start-Sleep -Milliseconds 300 }`, cwd: 'workspace:repo' });
const BG = b1.job?.job_id;
ok('T22 job_submit：立即返回 running', b1.status === 'ok' && b1.job?.state === 'running', JSON.stringify(b1).slice(0, 200));
await sleep(800);
const o1 = await callTool('job_output', { output_ref: `job:${BG}#0` });
const o1body = JSON.parse(o1.result.stdout);
ok('T23 job_output：running 期增量输出（tick-1 可见）', o1.status === 'ok' && o1body.data.includes('tick-1'), JSON.stringify(o1body).slice(0, 200));
await sleep(2500);
const s3 = await callTool('job_status', { job_id: BG });
ok('T24 job_status：后台 job finished', s3.status === 'ok' && JSON.parse(s3.result.stdout).state === 'finished', JSON.parse(s3.result.stdout)?.state);

const b2 = await callTool('job_submit', { node: 'pc-test', cmd: `Start-Sleep -Seconds 30`, cwd: 'workspace:repo' });
const BG2 = b2.job?.job_id;
await sleep(300);
const c1 = await callTool('job_cancel', { job_id: BG2 });
const c1s = await callTool('job_status', { job_id: BG2 });
ok('T25 job_cancel：取消生效', c1.status === 'ok' && ['cancelled', 'finished'].includes(JSON.parse(c1s.result.stdout).state), JSON.parse(c1s.result.stdout)?.state);

// ---------- unknown：在途调用 + 节点 SIGKILL → 对账语义 ----------
const killCall = callTool('exec', { node: 'pc-test', cmd: `Start-Sleep -Seconds 20`, cwd: 'workspace:repo', timeout_ms: 15000 }).catch((e) => ({ rpcError: String(e) }));
await sleep(1500); // journal: received → started
nodeProc.kill('SIGKILL');
const e9 = await killCall;
ok('T26 unknown：节点在途被杀 → class=network + 禁止重发指引', e9.status === 'unknown' && e9.error?.class === 'network' && /禁止|不得重发|对账/.test(e9.error.message), JSON.stringify(e9).slice(0, 300));
// journal 留存于 <nodeHome>/jobs/（01 §4.3）；被杀调用必须停在 started
const journals = fs.readdirSync(path.join(nodeHome, 'jobs')).filter((f) => /^c-[\w-]+\.json$/.test(f))
  .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(nodeHome, 'jobs', f), 'utf8')); } catch { return null; } })
  .filter(Boolean);
ok('T27 journal 留存：被杀调用停在 started（对账依据），其余 finished',
  journals.some((r) => r.state === 'started') && journals.filter((r) => r.state === 'finished').length >= 5,
  JSON.stringify(journals.map((r) => ({ id: r.call_id, state: r.state }))));

// offline（节点死亡后 socket 已关）
const e10 = await callTool('exec', { node: 'pc-test', cmd: `echo hi`, cwd: 'workspace:repo' });
ok('T28 offline：节点进程死亡后立即 offline', e10.status === 'failed' && e10.error?.class === 'offline', JSON.stringify(e10).slice(0, 200));

// ---------- 重启节点：重连 + 重发恢复 ----------
nodeProc = startNode();
let reconnected = false;
for (let i = 0; i < 80; i++) {
  await sleep(100);
  try {
    const { body } = await rest('/nodes', 'GET');
    const n = body.nodes?.find((n) => n.display_name === 'pc-test');
    if (n?.online) { reconnected = true; break; }
  } catch { /* 重试 */ }
}
ok('T29 节点重启自动重连（同身份 node_id）', reconnected && (await rest('/nodes', 'GET')).body.nodes.find((n) => n.display_name === 'pc-test')?.node_id === NODE_ID);
const e11 = await callTool('exec', { node: 'pc-test', cmd: `Write-Output 'after-restart-789'`, cwd: 'workspace:repo' });
ok('T30 重连后执行恢复', e11.status === 'ok' && e11.result.stdout.includes('after-restart-789'), JSON.stringify(e11).slice(0, 200));

// ---------- V5 代理：双 MCP 客户端并挂同一 hub（会话隔离 + 审批合并） ----------
const [ra, rb] = await Promise.all([
  callTool('exec', { node: 'pc-test', cmd: `Write-Output 'FROM-A'`, cwd: 'workspace:repo' }, { client: 'A' }),
  callTool('exec', { node: 'pc-test', cmd: `Write-Output 'FROM-B'`, cwd: 'workspace:repo' }, { client: 'B' }),
]);
ok('T31 双客户端并发调用互不串扰', ra.result.stdout.includes('FROM-A') && rb.result.stdout.includes('FROM-B'), JSON.stringify({ ra: ra.result.stdout, rb: rb.result.stdout }));

const ac = await callTool('exec', { node: 'pc-test', cmd: `Remove-Item -Recurse -Force ${path.join(work, 'merge-target')}`, cwd: 'workspace:repo' }, { client: 'A' });
const JOB3 = ac.job?.job_id;
const seenByB = await callTool('job_status', { job_id: JOB3 }, { client: 'B' });
await rest(`/jobs/${JOB3}/approve`);
const seenByBAfter = await waitForJob(JOB3, { client: 'B' });
ok('T32 审批合并：A 触发的审批卡，B 可见、单次批准后 B 侧读到终态',
  JSON.parse(seenByB.result.stdout).state === 'needs_approval' && seenByBAfter.state === 'finished',
  JSON.stringify({ before: JSON.parse(seenByB.result.stdout).state, after: seenByBAfter.state, env: seenByBAfter.envelope?.status }));

// 未授权令牌必须被拒（红队 P0-3）
const noAuth = await fetch(`${MCP}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
ok('T33 无令牌 401（管理面/工具面认证）', noAuth.status === 401, String(noAuth.status));

// ---------- attach 桥 smoke ----------
const attachProc = spawn(process.execPath, [hubBin, 'attach', '--hub', MCP, '--token', TOKEN], { stdio: ['pipe', 'pipe', 'pipe'] });
const attachResult = await new Promise((resolve) => {
  let buf = '';
  const t = setTimeout(() => resolve(null), 5000);
  attachProc.stdout.on('data', (c) => {
    buf += c.toString();
    const line = buf.split('\n').find((l) => l.includes('serverInfo'));
    if (line) { clearTimeout(t); try { resolve(JSON.parse(line)); } catch { resolve(null); } }
  });
  attachProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
});
attachProc.kill();
ok('T34 attach 桥：stdio ↔ HTTP 透传 initialize', attachResult?.result?.serverInfo?.name === 'mdp', JSON.stringify(attachResult)?.slice(0, 200));

// ---------- P1-1 overlay 全量（等级轴 / 路径域 / 夹紧 / 大小写折叠 / 即时推送） ----------
const outsideDir = path.join(work, 'outside');
fs.mkdirSync(outsideDir, { recursive: true });
fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside-content');
let junctionOk = false;
try { fs.symlinkSync(outsideDir, path.join(fixture, 'leak'), 'junction'); junctionOk = fs.existsSync(path.join(fixture, 'leak')); } catch { /* 非 NTFS 等 */ }
if (junctionOk) {
  const p1a = await callTool('fs', { node: 'pc-test', op: 'read', path: 'workspace:repo/leak/secret.txt' });
  ok('T35 symlink 逃逸拒绝（红队 P1-11）', p1a.status === 'denied' && p1a.error?.class === 'permission' && /逃逸|超出/.test(p1a.error?.message ?? ''), JSON.stringify(p1a).slice(0, 200));
  fs.rmSync(path.join(fixture, 'leak'), { recursive: true, force: true });
} else {
  console.log('SKIP  T35（junction 创建失败）');
}

const p1b = await callTool('fs', { node: 'pc-test', op: 'read', path: 'workspace:repo/../../Windows/win.ini' });
ok('T36 `..` 相对路径穿越拒绝', p1b.status === 'denied' && p1b.error?.class === 'permission', JSON.stringify(p1b).slice(0, 200));

const upperForm = fixture.toUpperCase() + '\\P11CASE.TXT';
const p1c = await callTool('fs', { node: 'pc-test', op: 'write', path: upperForm, content: 'case-fold' });
ok('T37 Windows 大小写折叠：全大写形态路径仍判定在域内', p1c.status === 'ok' && JSON.parse(p1c.result.stdout).written === 9, JSON.stringify(p1c).slice(0, 200));

const patchOverlay = (body) => fetch(`${MCP}/nodes/${NODE_ID}/overlay`, { method: 'PATCH', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const g1 = await callTool('exec', { node: 'pc-test', cmd: `echo hi`, cwd: 'workspace:repo' });
await patchOverlay({ levels: { exec: 'deny' } });
const g2 = await callTool('exec', { node: 'pc-test', cmd: `echo hi`, cwd: 'workspace:repo' });
await patchOverlay({ levels: { exec: 'allowlist' }, command_patterns_allow: ['node -p'] });
const g3 = await callTool('exec', { node: 'pc-test', cmd: `node -p "1+1"`, cwd: 'workspace:repo' });
const g4 = await callTool('exec', { node: 'pc-test', cmd: `echo not-on-list`, cwd: 'workspace:repo' });
await patchOverlay({ levels: { fs: 'read-only', exec: 'workspaces' } });
const g5 = await callTool('fs', { node: 'pc-test', op: 'write', path: 'workspace:repo/ro.txt', content: 'x' });
const g6 = await callTool('fs', { node: 'pc-test', op: 'read', path: 'workspace:repo/中文说明.txt' });
await patchOverlay({ levels: { fs: 'workspaces' } });
const g7 = await callTool('exec', { node: 'pc-test', cmd: `echo restored`, cwd: 'workspace:repo' });
ok('T38 overlay REST 编辑 + 即时推送全链', g1.status === 'ok' && g2.status === 'denied' && /exec=deny/.test(g2.error?.message ?? '')
  && g3.status === 'ok' && g3.result.stdout.trim() === '2' && g4.status === 'denied' && /allowlist/.test(g4.error?.message ?? '')
  && g5.status === 'denied' && /read-only/.test(g5.error?.message ?? '') && g6.status === 'ok'
  && g7.status === 'ok',
  JSON.stringify({ g1: g1.status, g2: g2.status + (g2.error?.message ?? ''), g3: g3.status, g4: g4.error?.message, g5: g5.error?.message, g6: g6.status, g7: g7.status }));
const ovGet = await (await fetch(`${MCP}/nodes/${NODE_ID}/overlay`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
ok('T39 overlay GET 回读（hub 为事实源）', ovGet.overlay?.levels?.fs === 'workspaces' && Array.isArray(ovGet.overlay?.path_domains), JSON.stringify(ovGet.overlay?.levels));

// ---------- P1-2 内容闸模式表 + 学习式白名单 ----------
fs.mkdirSync(path.join(work, 'learn-a'), { recursive: true });
fs.mkdirSync(path.join(work, 'learn-b'), { recursive: true });
const l1 = await callTool('exec', { node: 'pc-test', cmd: `Remove-Item -Recurse -Force ${path.join(work, 'learn-a')}`, cwd: 'workspace:repo' });
const LJ1 = l1.job?.job_id;
await fetch(`${MCP}/jobs/${LJ1}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ remember: true }) });
const l1r = await waitForJob(LJ1);
const l2 = await callTool('exec', { node: 'pc-test', cmd: `Remove-Item -Recurse -Force ${path.join(work, 'learn-b')}`, cwd: 'workspace:repo' });
ok('T40 学习式白名单：首批 remember 后同前缀免批', l1.status === 'needs_approval' && l1r.state === 'finished' && l2.status === 'ok',
  JSON.stringify({ l1: l1.status, l1r: l1r.state, l2: l2.status }));
const l3 = await callTool('exec', { node: 'pc-test', cmd: `rm -rf ${path.join(work, 'unlearned')}`, cwd: 'workspace:repo' });
const l3d = await fetch(`${MCP}/jobs/${l3.job?.job_id}/deny`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
ok('T41 不同前缀危险命令仍需审批（可 deny）', l3.status === 'needs_approval' && l3d.status === 200, JSON.stringify({ l3: l3.status, deny: l3d.status }));
await patchOverlay({ command_patterns_allow: [] });

const cg1 = await callTool('exec', { node: 'pc-test', cmd: `dd if=nul of=NUL`, cwd: 'workspace:repo' }); // 内建表命中 dd
await patchOverlay({ content_gate_patterns: ['MDP-FAKE-MARKER'] });
const cg2 = await callTool('exec', { node: 'pc-test', cmd: `dd if=nul of=NUL`, cwd: 'workspace:repo' }); // 自定义表覆盖内建 → 不再拦截
const cg3 = await callTool('exec', { node: 'pc-test', cmd: `echo MDP-FAKE-MARKER hit`, cwd: 'workspace:repo' }); // 自定义模式命中
const cg3d = await fetch(`${MCP}/jobs/${cg3.job?.job_id}/deny`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
await patchOverlay({ content_gate_patterns: [] });
ok('T42 模式表每节点可编辑（自定义表整体覆盖内建）',
  cg1.status === 'needs_approval' && cg2.status === 'ok' && cg3.status === 'needs_approval' && cg3d.status === 200,
  JSON.stringify({ cg1: cg1.status, cg2: cg2.status, cg3: cg3.status }));

// ---------- 收尾 ----------
hubProc.kill();
nodeProc.kill('SIGKILL');
await sleep(200);
fs.rmSync(work, { recursive: true, force: true });

console.log(`\n===== V5 结果：${passed} PASS / ${failed} FAIL =====`);
process.exit(failed === 0 ? 0 : 1);
