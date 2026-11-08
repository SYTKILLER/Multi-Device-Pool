/**
 * hub 状态（01 §1.2）：节点注册表 + job 注册表 + 管理令牌。
 * P0：hub.db 用 JSON 落盘（write-through）；P1 换 SQLite/原生 db 与 root 证书体系。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { NodeManifest, OverlayConfig, AuditRecord } from '@mdp/contract';

/** 自述对账用的审计记录（P1-3）：只留对账所需字段，最近 50 条 */
export type NodeAuditRecord = Pick<AuditRecord, 'seq' | 'kind' | 'op' | 'cmd' | 'ts'>;

export const defaultHome = (): string => process.env['MDP_HOME'] ?? path.join(os.homedir(), '.mdp');

export interface HubDbShape {
  nodes: Record<string, { manifest: NodeManifest; last_seen: string; overlay?: OverlayConfig; degraded?: { reason: string; at: string } }>;
  /** P1-5 审计锚定：hub 已验证到的链尾（broken 非空 = 校验失败，含断点详情）；recent 供自述对账 */
  audit?: Record<string, { last_seq: number; last_hash: string; broken?: string; recent?: NodeAuditRecord[] }>;
}

export const loadHubDb = (home: string): HubDbShape => {
  const file = path.join(home, 'hub.db.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as HubDbShape;
  } catch {
    return { nodes: {} };
  }
};

export const saveHubDb = (home: string, db: HubDbShape): void => {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'hub.db.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, file);
};

export const createHubToken = (): string => randomBytes(32).toString('hex');

/** 供 harness 挂载与测试读取：端口 + 令牌（等价 GUI 首访粘贴的令牌形态，01 §7） */
export const writeHubInfo = (home: string, info: Record<string, unknown>): string => {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'hub-info.json');
  fs.writeFileSync(file, JSON.stringify(info, null, 2));
  return file;
};
