/**
 * 自述对账（P1-3，01 §3.3）：自述称只读而审计出现写操作 → 自动降级 + 告警。
 * 判据：structured.levels.fs ∈ {deny, read-only} 且审计链含 fs write；
 *       structured.levels.exec = deny 且审计链含 exec。幂等重算（自述改回一致即自动清除）。
 * 不可信包裹：自由文本注入大脑时必须显式标记（红队 P1-9）。
 */

export const UNTRUSTED_PREFIX = '【不可信·仅供参考——节点自述可能与实际行为不符，以审计与 overlay 为准】';

export interface SelfDescViolation {
  reason: string;
}

/** 返回违规描述；无违规返回 undefined */
export const reconcileSelfDescription = (
  levels: { fs: string; exec: string },
  records: Array<{ kind: string; op?: string }>,
): SelfDescViolation | undefined => {
  const wroteFs = records.some((r) => r.kind === 'fs' && r.op === 'write');
  const ranExec = records.some((r) => r.kind === 'exec' || r.kind === 'job_submit');
  if ((levels.fs === 'deny' || levels.fs === 'read-only') && wroteFs) {
    return { reason: `自述 fs=${levels.fs} 但审计链存在写操作（fs write）——自动降级并告警（01 §3.3）` };
  }
  if (levels.exec === 'deny' && ranExec) {
    return { reason: `自述 exec=deny 但审计链存在执行记录——自动降级并告警（01 §3.3）` };
  }
  return undefined;
};
