/**
 * overlay（01 技术方案 §3.2）：主节点 GUI 设置、node agent 在执行路径上强制的外层 cap。
 * 远程调用的有效闸门 = overlay（确定性）+ LLM 自我约束（概率性）；harness 原生只管本地。
 */

export type OverlayMode = 'standard' | 'full_access';
/** 等级轴：deny < read-only < workspaces < allowlist < full */
export type OverlayLevel = 'deny' | 'read-only' | 'workspaces' | 'allowlist' | 'full';
export type ContentGate = 'approval' | 'off';

/** 等级轴序（P1-1 实装）：数值越大越宽松 */
export const LEVEL_ORDER: readonly OverlayLevel[] = ['deny', 'read-only', 'workspaces', 'allowlist', 'full'] as const;

/** level 是否达到最低要求 min */
export const levelAtLeast = (level: OverlayLevel, min: OverlayLevel): boolean =>
  LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(min);

/** standard 预设（P0 行为的具名化）：读写限工作区 + 内容闸审批 */
export const STANDARD: Omit<OverlayConfig, 'mode' | 'epoch'> = {
  enabled: true,
  levels: { fs: 'workspaces', exec: 'workspaces', transfer: 'workspaces' },
  path_domains: [],
  content_gate: 'approval',
  command_patterns_allow: [],
};

export interface OverlayConfig {
  mode: OverlayMode;
  enabled: boolean;
  levels: { fs: OverlayLevel; exec: OverlayLevel; transfer: OverlayLevel };
  /** realpath 后判定；exec cwd 夹紧（红队 P1-11）；[] = 用节点工作区路径 */
  path_domains: string[];
  /** approval（默认）| off（仅 full_access 预设） */
  content_gate: ContentGate;
  /** 内容闸模式表（P1-2：每节点可编辑；空 = 用内建初版集） */
  content_gate_patterns?: string[];
  /** 学习式白名单：首次前缀审批后累积 */
  command_patterns_allow: string[];
  /** 冷迁移世代：节点只接受当前 epoch 的 hub（01 §8.2） */
  epoch: number;
}

/** full_access 预设：池层完全不干涉（用户显式接受的残余风险，红队 P0-1 的逃生门） */
export const FULL_ACCESS: Omit<OverlayConfig, 'mode' | 'epoch'> = {
  enabled: true,
  levels: { fs: 'full', exec: 'full', transfer: 'full' },
  path_domains: ['*'],
  content_gate: 'off',
  command_patterns_allow: ['*'],
};
