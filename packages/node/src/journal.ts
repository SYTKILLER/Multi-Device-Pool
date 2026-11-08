/**
 * 执行 journal（01 §4.3）——@mdp/node 实现，蓝本 verification/v4-journal/journal.mjs（V4 5/5 PASS）。
 * 语义：received（已派发未开始，可安全重发）→ started（已开始，重发有副作用风险）→ finished（有结果）。
 * 持久化：tmp + rename 原子写，进程被杀不损文件（V4 场景 5）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { JournalRecord, JournalState, JournalVerdictDetail } from '@mdp/contract';

export class Journal {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  #file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  #write(id: string, rec: JournalRecord): void {
    const f = this.#file(id);
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, f);
  }

  read(id: string): JournalRecord | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.#file(id), 'utf8')) as JournalRecord;
    } catch {
      return undefined;
    }
  }

  mark(id: string, state: JournalState, extra: Partial<JournalRecord> = {}): void {
    const prev = this.read(id) ?? { call_id: id, state, history: [] };
    prev.state = state;
    prev.history.push({ state, ts: new Date().toISOString() });
    this.#write(id, { ...prev, ...extra });
  }

  /** 对账裁决——hub 重连节点时逐条询问，重试权归属的依据（01 §4.3） */
  verdict(id: string): JournalVerdictDetail {
    const rec = this.read(id);
    if (!rec) return { id, verdict: 'never_seen', detail: 'journal 无记录 → 可全新派发' };
    switch (rec.state) {
      case 'received': return { id, verdict: 'safe_redispatch', detail: '已接收未开始 → 可透明重发，无副作用' };
      case 'started': return { id, verdict: 'unknown_reconcile', detail: '已开始未结束 → 不得重发；报 unknown 并引导对账' };
      case 'finished': return { id, verdict: 'result_available', detail: `已完成，exit=${rec.exit ?? '?'} → 返回留存结果` };
      default: return { id, verdict: 'corrupt', detail: '未知状态' };
    }
  }

  /** hub 重连对账入口：按传入 id 列表逐条裁决 */
  reconcile(ids: string[]): JournalVerdictDetail[] {
    return ids.map((id) => this.verdict(id));
  }
}
