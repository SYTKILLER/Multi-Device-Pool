/**
 * 执行 journal（01 技术方案 §4.3）：正确性机制，与安全无关。
 * 已在 verification/v4-journal 以强杀模拟验证（5/5 PASS）。
 */

export type JournalState = 'received' | 'started' | 'finished';

export interface JournalRecord {
  call_id: string;
  state: JournalState;
  /** finished 时的留存结果引用 */
  exit?: number | null;
  output_ref?: string;
  history: Array<{ state: JournalState; ts: string }>;
}

/** hub 重连节点时逐条对账的裁决——重试权归属的依据 */
export type JournalVerdict =
  | 'never_seen'        // 可全新派发
  | 'safe_redispatch'   // received → 透明重发，无副作用
  | 'unknown_reconcile' // started → 禁止重发，status=unknown + 对账指引
  | 'result_available'  // finished → 返回留存结果
  | 'corrupt';

export interface JournalVerdictDetail {
  id: string;
  verdict: JournalVerdict;
  detail: string;
}
