/**
 * 节点审计日志（P1-5）：append-only JSONL，链式哈希（contract audit.ts 为唯一算法源）。
 * 崩溃容忍：appendFileSync 单行写入，进程死可能留下撕裂行——读取在首个坏行截断（tail-only 损失，前文不可篡改）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { auditHash, AUDIT_GENESIS, type AuditKind, type AuditRecord } from '@mdp/contract';

export class AuditLog {
  readonly file: string;
  #seq = 0;
  #lastHash = AUDIT_GENESIS;

  constructor(home: string) {
    this.file = path.join(home, 'audit.jsonl');
    this.#loadTail();
  }

  get seq(): number {
    return this.#seq;
  }

  get lastHash(): string {
    return this.#lastHash;
  }

  #loadTail(): void {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as AuditRecord;
        if (r.hash === auditHash({ seq: r.seq, ts: r.ts, call_id: r.call_id, kind: r.kind, cmd: r.cmd, op: r.op, exit: r.exit, result_hash: r.result_hash, prev_hash: r.prev_hash })
          && r.prev_hash === this.#lastHash && r.seq === this.#seq + 1) {
          this.#seq = r.seq;
          this.#lastHash = r.hash;
        } else { break; } // 链断（文件被外部改过）：从最后一个好点继续追加
      } catch { break; } // 撕裂行
    }
  }

  append(entry: { call_id: string; kind: AuditKind; cmd: string; op?: string; exit: number | null; result_hash: string }): AuditRecord {
    const record: Omit<AuditRecord, 'hash'> = {
      seq: this.#seq + 1,
      ts: new Date().toISOString(),
      call_id: entry.call_id,
      kind: entry.kind,
      cmd: entry.cmd.slice(0, 500),
      op: entry.op,
      exit: entry.exit,
      result_hash: entry.result_hash,
      prev_hash: this.#lastHash,
    };
    const full: AuditRecord = { ...record, hash: auditHash(record) };
    fs.appendFileSync(this.file, JSON.stringify(full) + '\n');
    this.#seq = full.seq;
    this.#lastHash = full.hash;
    return full;
  }

  /** hub 拉取：seq > since 的记录；遇坏行截断（tail-only） */
  readSince(since: number): AuditRecord[] {
    const out: AuditRecord[] = [];
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return out; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as AuditRecord;
        if (r.seq > since) out.push(r);
      } catch { break; }
    }
    return out;
  }
}
