/**
 * 线缆帧协议（P2-1 接线，0.3.0 新增）：**向后兼容的混合帧**——
 * 控制帧维持 P0 的换行分隔 JSON（老节点/老 hub 不受影响）；二进制帧为
 * 「`{t:'bin',...}` 头行 + 定长裸字节 + `\n` 回步哨兵」。
 *
 * 为什么不用统一长度前缀重封全部帧：V5 的 54 项回归与新老节点混池（hub 先升级、
 * 节点按机各自升级）都依赖旧 JSON 行可独立解析；混合帧让二进制能力按
 * manifest.capabilities + agent_version（FEATURE_MIN.transfer=0.3.0）协商开关。
 *
 * 哨兵：TCP 保序不保"帧界"，净荷可含任意字节（含 \n 与形似 JSON 的内容）；
 * 接收端按 bytes 定长取净荷后必须紧跟一个 \n，否则视为流失步（fatal，断连重连）。
 * frame 级 sha256 不设：块级完整性由 Assembler 对照 manifest 逐块校验，双查冗余。
 */
import { createHash } from 'node:crypto';

export interface BinFrameHeader {
  t: 'bin';
  /** 携带本流的 hub 侧 call_id（transfer 调用的派发 ID） */
  stream: string;
  /** 块序号（= manifest 块索引，诊断用；Assembler 按索引幂等去重） */
  seq: number;
  /** 裸字节数（不含哨兵） */
  bytes: number;
}

/** 单帧净荷上限（默认块 1 MiB，此上限是协议防线而非业务限制） */
export const MAX_BIN_FRAME_BYTES = 8 * 1024 * 1024;
/** 单次 transfer 的总字节上限（更大载荷属 P3 job 化传输；测试经 MDP_TRANSFER_MAX_BYTES 调低） */
export const MAX_TRANSFER_BYTES = Number(process.env['MDP_TRANSFER_MAX_BYTES'] ?? 256 * 1024 * 1024);

export const encodeControlFrame = (obj: Record<string, unknown>): Buffer =>
  Buffer.from(JSON.stringify(obj) + '\n', 'utf8');

export const encodeBinFrame = (header: Omit<BinFrameHeader, 't'>, payload: Buffer): Buffer => {
  if (payload.length > MAX_BIN_FRAME_BYTES) throw new Error(`bin 帧超限：${payload.length} > ${MAX_BIN_FRAME_BYTES}`);
  const head = encodeControlFrame({ ...header, t: 'bin', bytes: payload.length });
  return Buffer.concat([head, payload, Buffer.from('\n', 'utf8')]);
};

type Handlers = {
  onFrame: (msg: Record<string, unknown>) => void;
  onBin: (header: BinFrameHeader, payload: Buffer) => void;
  /** 流失步/超限等协议级错误：调用方必须断连重连（缓冲区已不可信） */
  onViolation: (reason: string) => void;
};

/**
 * 有状态帧解码器：line 模式 ↔ bin 模式切换。容忍 TCP 任意分段
 * （一个 chunk 内多帧、一帧跨多 chunk、净荷内含 \n 均正确）。
 */
export class WireDecoder {
  #line = '';
  #binHeader?: BinFrameHeader;
  #binBuf?: Buffer;
  #binFilled = 0;
  #handlers: Handlers;

  constructor(handlers: Handlers) {
    this.#handlers = handlers;
  }

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#binHeader) {
        const want = this.#binBuf!.length - this.#binFilled;
        const take = Math.min(want, chunk.length - offset);
        chunk.copy(this.#binBuf!, this.#binFilled, offset, offset + take);
        this.#binFilled += take;
        offset += take;
        if (this.#binFilled === this.#binBuf!.length) {
          const last = this.#binBuf![this.#binBuf!.length - 1];
          if (last !== 0x0a) {
            this.#handlers.onViolation(`bin 帧尾哨兵缺失（stream=${this.#binHeader.stream} seq=${this.#binHeader.seq}）——流失步`);
            this.#binHeader = undefined;
            this.#binBuf = undefined;
            this.#binFilled = 0;
            this.#line = '';
            return;
          }
          const payload = this.#binBuf!.subarray(0, this.#binBuf!.length - 1);
          const h = this.#binHeader;
          this.#binHeader = undefined;
          this.#binBuf = undefined;
          this.#binFilled = 0;
          this.#handlers.onBin(h, payload);
        }
        continue;
      }
      const nl = chunk.indexOf(0x0a, offset);
      if (nl < 0) {
        this.#line += chunk.toString('utf8', offset);
        return;
      }
      this.#line += chunk.toString('utf8', offset, nl);
      offset = nl + 1;
      const line = this.#line;
      this.#line = '';
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.#handlers.onFrame({ t: '__bad_json', raw: line.slice(0, 200) });
        continue;
      }
      if (msg['t'] === 'bin') {
        const bytes = Number(msg['bytes']);
        const stream = String(msg['stream'] ?? '');
        const seq = Number(msg['seq'] ?? -1);
        if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_BIN_FRAME_BYTES || !stream) {
          this.#handlers.onViolation(`bin 头行非法（bytes=${msg['bytes']} stream=${stream}）`);
          return;
        }
        this.#binHeader = { t: 'bin', stream, seq, bytes };
        this.#binBuf = Buffer.allocUnsafe(bytes + 1); // +1 = 哨兵
        this.#binFilled = 0;
        continue;
      }
      this.#handlers.onFrame(msg);
    }
  }
}

/** 内容寻址小工具：transfer 信封与本地 CLI 比对共用（P2-4 双侧 SHA256 一致性） */
export const sha256Hex = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
