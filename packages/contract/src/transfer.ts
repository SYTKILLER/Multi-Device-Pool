/**
 * transfer 协议类型（P2-1 接线 + P2-2 血统，0.3.0 一次定稿——避免两次动契约）。
 *
 * 方向与边界（P2 范围）：
 * - push：hub 宿主机文件 → 节点工作区（hub 侧无路径域限制——hub 宿主为信任域，
 *   MCP 调用已 token 鉴权；节点侧目标必须过 overlay transfer 等级 + 路径域）。
 * - fetch：节点工作区文件 → hub 收件箱 <home>/inbox/<transfer_id>/。
 * - node↔node 直传不做（hub-star 拓扑，超范围）。
 * 分块清单/组装语义复用 @mdp/transfer（chunk/assemble）；此处只定协议面类型。
 */

/** 逐块清单（原 @mdp/transfer ChunkedFile——上移到 contract 供两端共用，transfer 包 re-export） */
export interface ChunkMeta { index: number; offset: number; size: number; sha256: string }
export interface ChunkedFile { size: number; fileSha256: string; chunkSize: number; chunks: ChunkMeta[] }

/** 节点侧接收调用（kind=transfer_receive）参数：manifest 随 call 行走（小 JSON），净荷走 bin 帧 */
export interface TransferReceiveParams {
  transfer_id: string;
  /** 目标工作区引用 workspace:<name> + 相对路径 */
  workspace: string;
  rel_path: string;
  manifest: ChunkedFile;
}

/** 节点侧发送调用（kind=transfer_send）参数；节点先回 manifest 信封，再流 bin 帧 */
export interface TransferSendParams {
  transfer_id: string;
  /** 节点工作区路径引用，如 workspace:repo/dist/a.bin */
  path: string;
}

/** transfer 信封 result 的 stdout JSON（与 exec/fs 信封同形：stdout 装 JSON 文本） */
export interface TransferOutcome {
  transfer_id: string;
  file_sha256: string;
  bytes: number;
  chunks: number;
  /** fetch 方向：hub 收件箱落位绝对路径 */
  inbox_path?: string;
  /** 接收方部分失败时给出缺块索引（hub 可按差量重流；Assembler 幂等续传） */
  missing?: number[];
  rejected?: Array<{ index: number; reason: string }>;
}

/**
 * 血统（P2-2，0.3.0 预留）：transfer 落地 → hub 持久化 LineageRecord + 向目标节点
 * 下发 LineageDirective → 节点更新 workspace 条目（revision++/superseded/source_node）
 * 并按 manifest_version++ 重报签名 manifest。superseded 的签发语义（源副本何时让位）
 * 属 P2-2 实装；0.3.0 只保证通道与字段就绪。
 */
export interface LineageRecord {
  workspace_id: string;
  revision: number;
  superseded?: boolean;
  source_node?: string;
  origin: 'push' | 'fetch' | 'local';
  transfer_id: string;
  file_sha256: string;
  rel_path: string;
  at: string;
}

/** hub → 节点血统指令帧（控制帧，新 t 值；旧节点收到按 default 忽略——向后兼容） */
export interface LineageDirective {
  t: 'lineage';
  updates: Array<{ workspace_id: string; revision: number; superseded?: boolean; source_node?: string }>;
}
