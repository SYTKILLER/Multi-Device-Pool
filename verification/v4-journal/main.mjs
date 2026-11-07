// V4 主控：四个场景 + 对账断言（精确 PID 杀法，绝不误伤其他进程）
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(dir, 'worker.mjs');

const spawnWorker = (mode, callId, sleepMs) =>
  spawn(process.execPath, [worker, mode, callId, String(sleepMs ?? 0)], { stdio: 'ignore' });
const reconcile = (callId) => {
  const r = spawnSync(process.execPath, [worker, 'reconcile', callId], { timeout: 30000, encoding: 'utf8' });
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const assert = (name, cond, detail) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`); };

// 场景 1：started 后进程被杀（崩溃/断电/睡眠强杀）→ 对账判 unknown_reconcile，绝不允许重发
const j1 = spawnWorker('dispatch', 'j1', 20000);
await sleep(3000);
j1.kill('SIGKILL');
await sleep(500);
assert('场景1 started 被杀 → unknown_reconcile', reconcile('j1').verdict === 'unknown_reconcile');

// 场景 2：received 后、started 前被杀 → 对账判 safe_redispatch（hub 可透明重发）
const j2 = spawnWorker('dispatch-fast', 'j2');
await sleep(800);
j2.kill('SIGKILL');
await sleep(500);
assert('场景2 received 被杀 → safe_redispatch', reconcile('j2').verdict === 'safe_redispatch');

// 场景 3：正常完成 → result_available
spawnSync(process.execPath, [worker, 'dispatch', 'j3', 800], { timeout: 30000 });
assert('场景3 正常完成 → result_available', reconcile('j3').verdict === 'result_available');

// 场景 4：从未派发 → never_seen
assert('场景4 从未派发 → never_seen', reconcile('j4').verdict === 'never_seen');

// 场景 1 补充：journal 文件在强杀后仍完好（原子写有效性）
const fs = await import('node:fs');
const j1raw = fs.readFileSync(path.join(dir, 'journal-data', 'j1.json'), 'utf8');
assert('场景1 journal 文件强杀后完好可解析', JSON.parse(j1raw).state === 'started');

console.log(`\n== V4 结果: ${pass} PASS / ${fail} FAIL ==`);
process.exit(fail > 0 ? 1 : 0);
