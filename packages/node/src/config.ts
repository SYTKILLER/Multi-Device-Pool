/**
 * 节点配置（01 §2.3）：手工列出工作区，不自动扫描；变更即重报 manifest。
 * P0 形态：JSON 文件（--config）或显式参数；hub 地址必填。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface WorkspaceConfig {
  name: string;
  path: string;
}

export interface NodeConfig {
  hub: string;              // host:port
  display_name: string;     // ≤16 字符，进工具前缀（01 §2.1）
  workspaces: WorkspaceConfig[];
  /** 学习式白名单（01 §3.2），P0 仅透传上报 */
  command_patterns_allow?: string[];
}

export const loadConfig = (configPath: string | undefined, overrides: Partial<NodeConfig>): NodeConfig => {
  let base: Partial<NodeConfig> = {};
  if (configPath) base = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<NodeConfig>;
  const cfg: NodeConfig = {
    hub: overrides.hub ?? base.hub ?? '127.0.0.1:7900',
    display_name: (overrides.display_name ?? base.display_name ?? os.hostname()).slice(0, 16),
    workspaces: overrides.workspaces ?? base.workspaces ?? [],
    command_patterns_allow: overrides.command_patterns_allow ?? base.command_patterns_allow ?? [],
  };
  // 工作区路径归一为绝对路径，overlay 按 realpath 判定（红队 P1-11）
  cfg.workspaces = cfg.workspaces.map((w) => ({ ...w, path: path.resolve(w.path) }));
  return cfg;
};
