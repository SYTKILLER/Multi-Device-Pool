/**
 * overlay（01 技术方案 §3.2）：主节点 GUI 设置、node agent 在执行路径上强制的外层 cap。
 * 远程调用的有效闸门 = overlay（确定性）+ LLM 自我约束（概率性）；harness 原生只管本地。
 */

export type OverlayMode = 'standard' | 'full_access';
/** 等级轴：deny < read-only < workspaces < allowlist < full */
export type OverlayLevel = 'deny' | 'read-only' | 'workspaces' | 'allowlist' | 'full';
export type ContentGate = 'approval' | 'off';

export interface OverlayConfig {
  mode: OverlayMode;
  enabled: boolean;
  levels: { fs: OverlayLevel; exec: OverlayLevel; transfer: OverlayLevel };
  /** realpath 后判定；exec cwd 夹紧（红队 P1-11） */
  path_domains: string[];
  /** approval（默认）| off（仅 full_access 预设） */
  content_gate: ContentGate;
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
