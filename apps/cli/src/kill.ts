/**
 * 进程树终止（P1-6）。verification-p0 §6 实录：Windows 上"停 npm 包装 ≠ 停 node agent"——
 * 杀父进程留下孤儿且 hub 连接保持。因此 stop 一律**按树杀**：
 * - win32：`taskkill /PID <pid> /T /F`（/T=树，/F=强制；TerminateProcess，SIGKILL 语义）
 * - POSIX：SIGTERM → 宽限 3s → SIGKILL；进程组树杀需要 spawn detached + kill(-pid)，
 *   node agent 当前未按组启动，故 P1 只杀单进程并记录局限（Windows 为首要开发/部署平台）
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export const pidAlive = async (pid: number): Promise<boolean> => {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await exec('tasklist', ['/FI', `PID eq ${pid}`, '/NH']);
      return stdout.includes(String(pid));
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const killTree = async (pid: number): Promise<{ killed: boolean; how: string }> => {
  if (!(await pidAlive(pid))) return { killed: false, how: `PID ${pid} 不存在` };
  if (process.platform === 'win32') {
    try {
      await exec('taskkill', ['/PID', String(pid), '/T', '/F']);
    } catch (e) {
      return { killed: false, how: `taskkill 失败：${String((e as Error).message).slice(0, 120)}` };
    }
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { return { killed: false, how: `kill 失败：PID ${pid}` }; }
    const deadline = Date.now() + 3000;
    while ((await pidAlive(pid)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    try { if (await pidAlive(pid)) process.kill(pid, 'SIGKILL'); } catch { /* 已死 */ }
  }
  // 等待真正消失（最多 5s）
  const deadline = Date.now() + 5000;
  while ((await pidAlive(pid)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const gone = !(await pidAlive(pid));
  return { killed: gone, how: gone ? `PID ${pid} 进程树已终止` : `PID ${pid} 终止指令已发出但仍在存活（需人工核查）` };
};
