/**
 * 节点 manifest（01 技术方案 §3.4）：子节点签名上报，连接时全量、变更时重报（manifest_version 递增）。
 */

export type Availability = 'session' | 'service';
/** 内层报告字段：只描述子节点 harness 原生约束是否在本地路径生效；对远程调用不生效（01 §3.1） */
export type NativeEnforcement = 'hook' | 'none';

export interface WorkspaceEntry {
  name: string;
  path: string;
  revision: number;
  workspace_id: string;
  /** transfer 落到别处后被标 superseded（01 §5.2 血统） */
  superseded: boolean;
  source_node?: string;
}

export interface PermissionSelfDescription {
  /** node agent 生成并签名的结构化字段 */
  structured: {
    levels: { fs: string; exec: string; transfer: string };
    path_domains: string[];
    command_patterns_allow: string[];
  };
  /** 自由文本：可能由子节点 harness 用 LLM 生成，注入主大脑时必须按不可信数据包裹（红队 P1-9） */
  text: string;
}

export interface NodeManifest {
  manifest_version: number;
  node_id: string;            // 公钥哈希 16 hex（主键）
  display_name: string;       // ≤16 字符，进工具前缀
  os: string;
  arch: string;
  shell: string;              // 默认 shell，如 powershell / bash
  agent_version: string;
  capabilities: Array<'exec' | 'fs' | 'transfer'>;
  workspaces: WorkspaceEntry[];
  available: Availability;
  native_enforcement: NativeEnforcement;
  self_description: PermissionSelfDescription;
}
