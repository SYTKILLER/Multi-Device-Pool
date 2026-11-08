/**
 * 发现协议载荷 schema（mdp/1）+ 端口常量（P1-7 适配层共用；契约变更请求 2026-11-09 由 B 提出、A 迁入）。
 * 编解码与校验实现仍在 packages/adapter-direct（本包只承载类型与常量，零逻辑）。
 * 注：单播发现端口与 TCP 节点端点同号（同端口不同协议）；组播为自定义 announce 协议（决策请求 #1 待用户拍板）。
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
/** 自定义组播 announce 协议（V3 定论：同介质优化路径） */
export const ANNOUNCE_GROUP = '239.255.77.68';
export const ANNOUNCE_PORT = 53550;
/** 单播直投发现端口（主路径，与 TCP 节点端点同号不同协议） */
export const ANNOUNCE_UNICAST_PORT = 7900;
