// V4: 执行 journal（@mdp/node 未来实现的蓝本，01 文档 §4.3）
// 语义：received（已派发未开始，可安全重发）→ started（已开始，重发有副作用风险）→ finished（有结果）
// 持久化：tmp + rename 原子写，进程被杀也不损文件。
import fs from 'node:fs';
import path from 'node:path';

export class Journal {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  #file(id) { return path.join(this.dir, `${id}.json`); }
  #write(id, rec) {
    const f = this.#file(id);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, f);
  }
  read(id) {
    try { return JSON.parse(fs.readFileSync(this.#file(id), 'utf8')); } catch { return undefined; }
  }
  mark(id, state, extra = {}) {
    const prev = this.read(id) ?? { call_id: id, history: [] };
    prev.state = state;
    prev.history.push({ state, ts: new Date().toISOString() });
    this.#write(id, { ...prev, ...extra });
  }
  // 对账裁决（hub 重连节点时逐条询问，节点据此回答）
  verdict(id) {
    const rec = this.read(id);
    if (!rec) return { id, verdict: 'never_seen', detail: 'journal 无记录 → 可全新派发' };
    switch (rec.state) {
      case 'received': return { id, verdict: 'safe_redispatch', detail: '已接收未开始 → 可透明重发，无副作用' };
      case 'started':  return { id, verdict: 'unknown_reconcile', detail: '已开始未结束 → 不得重发；报 unknown 并引导对账' };
      case 'finished': return { id, verdict: 'result_available', detail: `已完成，exit=${rec.exit} → 返回留存结果` };
      default:         return { id, verdict: 'corrupt', detail: '未知状态' };
    }
  }
}
