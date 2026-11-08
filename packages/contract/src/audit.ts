/**
 * 执行审计哈希链（P1-5，01 §9 审计篡改防线）：node JSONL 链式哈希 + hub 定期拉取锚定。
 * 哈希算法与拼串格式**必须在 contract**——node 写入与 hub 校验必须逐字节一致，防实现漂移。
 * result hash = sha256(stdout + stderr + exit)（01 §9）；链哈希 = sha256(固定序字段串)。
 */
import { createHash } from 'node:crypto';

export type AuditKind = 'exec' | 'fs' | 'job_submit';

export interface AuditRecord {
  seq: number;
  ts: string;
  call_id: string;
  kind: AuditKind;
  /** 命令全文或 fs 路径摘要 */
  cmd: string;
  /** fs 的 op（exec/job_submit 无） */
  op?: string;
  exit: number | null;
  /** sha256(stdout + stderr + exit) */
  result_hash: string;
  /** 前一条链哈希；首条 = GENESIS */
  prev_hash: string;
  /** 链哈希 */
  hash: string;
}

export const AUDIT_GENESIS = '0'.repeat(64);

/** 执行结果哈希（01 §9：result hash = sha256(stdout+stderr+exit)） */
export const resultHash = (stdout: string, stderr: string, exit: number | null): string =>
  createHash('sha256').update(`${stdout}\u0000${stderr}\u0000${exit ?? 'null'}`).digest('hex');

/** 链哈希：固定序字段串，无 JSON 序歧义 */
export const auditHash = (r: Omit<AuditRecord, 'hash'>): string =>
  createHash('sha256')
    .update([r.seq, r.ts, r.call_id, r.kind, r.cmd, r.op ?? '', r.exit ?? 'null', r.result_hash, r.prev_hash].join('|'))
    .digest('hex');

/** 校验一段记录链的连续性（prev 链接 + hash 重算）；返回首个坏点 */
export const verifyAuditChain = (
  records: AuditRecord[],
  startPrevHash: string,
): { ok: boolean; brokenAt?: number; reason?: string } => {
  let prev = startPrevHash;
  for (const r of records) {
    const expect = auditHash({ seq: r.seq, ts: r.ts, call_id: r.call_id, kind: r.kind, cmd: r.cmd, op: r.op, exit: r.exit, result_hash: r.result_hash, prev_hash: r.prev_hash });
    if (r.prev_hash !== prev) return { ok: false, brokenAt: r.seq, reason: `prev_hash 断链（期望 ${prev.slice(0, 12)}…，实得 ${r.prev_hash.slice(0, 12)}…）` };
    if (r.hash !== expect) return { ok: false, brokenAt: r.seq, reason: `hash 重算不符（seq ${r.seq} 被篡改）` };
    prev = r.hash;
  }
  return { ok: true };
};
