/**
 * 统一结果信封（01 技术方案 §4.3）。
 * 所有跨节点工具调用的返回形态；错误分类学决定重试权归属。
 */

export type CallStatus =
  | 'ok'
  | 'denied'          // 被 overlay / 内容闸 / harness 原生拒绝（永不重试）
  | 'failed'          // 执行了但失败（crash 等系统级）
  | 'timeout'
  | 'unknown'         // journal=started 但结局不明：禁止重发，走对账
  | 'needs_approval'; // 已转 job，返回 job_id

export type ErrorClass =
  | 'network'     // hub 查 journal 决定透明重发（仅纯读）或上报 unknown
  | 'permission'  // 拒绝原因原文透传给 LLM
  | 'busy'        // .git/index.lock 等工作区锁冲突
  | 'offline'
  | 'timeout'
  | 'crash';

export interface EnvelopeError {
  class: ErrorClass;
  /** 是否可自动重试（仅纯读的 network 类为 true；重试决策在 hub，不在 LLM） */
  retryable: boolean;
  /** harness 原始拒绝原因 / 诊断原文——LLM 纠错的原材料 */
  message: string;
}

export interface EnvelopeResult {
  exit: number | null;
  stdout: string;
  stderr: string;
  /** inline 截断发生时为 true，全量输出经 output_ref 分页取回 */
  truncated: boolean;
  /** 全量输出引用，如 "job:42#0" */
  output_ref?: string;
}

export interface EnvelopeJob {
  job_id: string;
  state: 'needs_approval' | 'running' | 'finished' | 'denied' | 'expired' | 'cancelled';
}

export interface ResultEnvelope {
  status: CallStatus;
  node_id: string;
  /** hub 签发的调用 ID（幂等内化：LLM 不接触幂等键） */
  call_id: string;
  /** hub 时间戳——跨设备时钟偏移免疫（红队 P2-6） */
  ts_hub: number;
  error?: EnvelopeError;
  result?: EnvelopeResult;
  job?: EnvelopeJob;
  /** 工作区血统警告等非致命提示（01 §5.2 superseded） */
  warnings?: string[];
}

export const envelope = (
  base: Pick<ResultEnvelope, 'status' | 'node_id' | 'call_id' | 'ts_hub'>,
): ResultEnvelope => base;
