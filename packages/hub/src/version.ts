/**
 * 版本协商（P1-4，01 §9 P2-7 前置）：hello 已携带 manifest.agent_version + capabilities，
 * hub 按最低版本表禁用相关能力并出提示；FS 等基础能力门槛低，新能力随版本抬高。
 */
import type { NodeManifest } from '@mdp/contract';

export type Capability = 'exec' | 'fs' | 'transfer';

/** 各能力最低 agent 版本（低于即禁用；测试用 0.0.9 模拟旧节点：exec 禁用、fs 仍可用） */
export const FEATURE_MIN: Record<Capability, string> = {
  exec: '0.1.0',
  fs: '0.0.1',
  transfer: '99.0.0', // P2 未实现，恒不可用
};

export const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

export interface FeatureStatus {
  available: boolean;
  min: string;
  agent: string;
  hint?: string;
}

export const featureStatus = (manifest: NodeManifest): Record<Capability, FeatureStatus> => {
  const out = {} as Record<Capability, FeatureStatus>;
  for (const cap of Object.keys(FEATURE_MIN) as Capability[]) {
    const min = FEATURE_MIN[cap]!;
    const agent = manifest.agent_version;
    const declared = manifest.capabilities.includes(cap as NodeManifest['capabilities'][number]);
    const available = declared && compareVersions(agent, min) >= 0;
    out[cap] = {
      available,
      min,
      agent,
      hint: available ? undefined : `节点 ${manifest.display_name} agent ${agent} 低于 ${cap} 最低要求 ${min}，请升级节点 agent（npm i -g @mdp/node@latest 形态）`,
    };
  }
  return out;
};
