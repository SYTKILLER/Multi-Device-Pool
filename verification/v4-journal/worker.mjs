// V4: worker 子进程——三种模式，模拟 node agent 的执行生命周期
import { Journal } from './journal.mjs';

const [, , mode, callId, sleepMs] = process.argv;
const journal = new Journal(new URL('./journal-data/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

if (mode === 'dispatch') {
  journal.mark(callId, 'received');
  await new Promise(r => setTimeout(r, 200));   // 收尾与开始之间留出"可被杀"窗口
  journal.mark(callId, 'started');
  await new Promise(r => setTimeout(r, Number(sleepMs ?? 20000)));  // 长任务窗口（此时被杀 = 崩溃/断电模拟）
  journal.mark(callId, 'finished', { exit: 0 });
  console.log(`[worker] ${callId} finished`);
} else if (mode === 'dispatch-fast') {
  // received 后立即被杀的场景（崩溃在开始前）
  journal.mark(callId, 'received');
  await new Promise(r => setTimeout(r, 5000));
} else if (mode === 'reconcile') {
  const v = journal.verdict(callId);
  console.log(JSON.stringify(v));
}
