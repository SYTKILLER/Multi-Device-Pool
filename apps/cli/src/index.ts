/**
 * mdp CLI（01 §1.2：hub/node 生命周期）。P1-6 范围：stop（node/hub）+ status。
 *   mdp node stop [--home <dir>]   读 <home>/node.pid，按进程树杀（见 kill.ts 的 §6 教训）
 *   mdp hub  stop [--home <dir>]   读 <home>/hub-info.json 的 pid，同构
 *   mdp node status [--home <dir>] / mdp hub status
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { killTree, pidAlive } from './kill.js';

const homeOf = (): string => {
  const i = process.argv.indexOf('--home');
  return i >= 0 ? (process.argv[i + 1] ?? os.homedir() + '/.mdp') : process.env['MDP_HOME'] ?? path.join(os.homedir(), '.mdp');
};

const readPid = (file: string, label: string): number | undefined => {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    console.error(`[mdp] 未找到 ${label} 的 PID 文件（${file}）——${label} 可能从未启动过`);
    return undefined;
  }
};

const doStop = async (kind: 'node' | 'hub'): Promise<void> => {
  const home = homeOf();
  const file = kind === 'node' ? path.join(home, 'node.pid') : path.join(home, 'hub-info.json');
  let pid: number | undefined;
  if (kind === 'node') {
    pid = readPid(file, 'node agent');
  } else {
    try {
      pid = (JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number }).pid;
    } catch {
      console.error(`[mdp] 未找到 hub 的 hub-info.json（${file}）——hub 可能从未启动过`);
    }
  }
  if (pid === undefined) process.exit(1);
  if (!(await pidAlive(pid))) {
    console.log(`[mdp] ${kind} PID ${pid} 已不在运行${kind === 'node' ? '（清理陈旧 PID 文件）' : ''}`);
    if (kind === 'node') { try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ } }
    return;
  }
  const r = await killTree(pid);
  console.log(`[mdp] ${kind} stop：${r.how}`);
  if (kind === 'node' && r.killed) { try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ } }
  if (!r.killed) process.exit(1);
};

const doStatus = async (kind: 'node' | 'hub'): Promise<void> => {
  const home = homeOf();
  const file = kind === 'node' ? path.join(home, 'node.pid') : path.join(home, 'hub-info.json');
  let pid: number | undefined;
  try {
    pid = kind === 'node'
      ? Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
      : (JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number }).pid;
  } catch { /* 未启动 */ }
  if (pid === undefined) { console.log(`[mdp] ${kind}: 未运行（无 PID 记录）`); return; }
  console.log(`[mdp] ${kind}: PID ${pid} ${await pidAlive(pid) ? '运行中' : '已死（陈旧记录）'}`);
};

const [, , sub, kind] = process.argv;
if (sub === 'node' && kind === 'stop') await doStop('node');
else if (sub === 'hub' && kind === 'stop') await doStop('hub');
else if (sub === 'node' && kind === 'status') await doStatus('node');
else if (sub === 'hub' && kind === 'status') await doStatus('hub');
else {
  console.error('用法：mdp <node|hub> <stop|status> [--home <dir>]');
  process.exit(2);
}
