/**
 * announce 编解码与校验（实现层）。schema 与常量已迁入 @mdp/contract（契约变更 2026-11-09，A 迁入、B 接线）——
 * 本文件保留 encode/parse 实现并对包内旧导入路径保持再导出兼容。
 */
import { ANNOUNCE_MAX_BYTES, type AnnouncePayload } from '@mdp/contract';

export type { AnnouncePayload, AnnounceKind, AnnounceRole } from '@mdp/contract';
export { ANNOUNCE_MAX_BYTES } from '@mdp/contract';

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
