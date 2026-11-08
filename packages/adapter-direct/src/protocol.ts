/**
 * announce 载荷协议（mdp/1）。
 * 注：本 schema 暂居本包——已登记契约变更请求，待 A 机接线 hub/node 时迁入 @mdp/contract（docs/p1-board.md）。
 */

export type AnnounceKind = 'announce' | 'announce_reply';
export type AnnounceRole = 'hub' | 'node';

export interface AnnouncePayload {
  proto: 'mdp/1';
  kind: AnnounceKind;
  role: AnnounceRole;
  /** display_name（节点）或 hub 名 */
  name: string;
  /** node_id（公钥哈希）或 hub root 公钥指纹 */
  id: string;
  /** 对端 TCP 端点端口（node=agent 端口 / hub=节点协议端口） */
  tcpPort?: number;
  /** 仅 hub 携带（01 §8.2 epoch 语义） */
  epoch?: number;
  ts: number;
}

/** 单报文硬上限：UDP 载荷防滥用（红队 P2-10 同族：任何网络输入先限量） */
export const ANNOUNCE_MAX_BYTES = 1024;

export const encodeAnnounce = (p: AnnouncePayload): Buffer => {
  const buf = Buffer.from(JSON.stringify(p), 'utf8');
  if (buf.length > ANNOUNCE_MAX_BYTES) throw new Error(`announce 载荷超限：${buf.length} > ${ANNOUNCE_MAX_BYTES}`);
  return buf;
};

export const parseAnnounce = (buf: Buffer): AnnouncePayload | null => {
  if (buf.length > ANNOUNCE_MAX_BYTES) return null;
  let v: unknown;
  try { v = JSON.parse(buf.toString('utf8')); } catch { return null; }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o['proto'] !== 'mdp/1') return null;
  if (o['kind'] !== 'announce' && o['kind'] !== 'announce_reply') return null;
  if (o['role'] !== 'hub' && o['role'] !== 'node') return null;
  if (typeof o['name'] !== 'string' || o['name'].length === 0 || o['name'].length > 64) return null;
  if (typeof o['id'] !== 'string' || o['id'].length === 0 || o['id'].length > 64) return null;
  if (typeof o['ts'] !== 'number') return null;
  if (o['tcpPort'] !== undefined && typeof o['tcpPort'] !== 'number') return null;
  if (o['epoch'] !== undefined && typeof o['epoch'] !== 'number') return null;
  return v as AnnouncePayload;
};
