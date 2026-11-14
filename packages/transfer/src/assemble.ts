/**
 * 组装器（P2-1，01 §5.2）：分块 → 预分配 staging 随机写（逐块 sha256 先验）→ finalize 全量校验 → 原子替换。
 * 断点续传：received 集合持久化于 <staging>.json（原子写），重启/重连后 missing() 给出差量。
 * Windows 原子替换：rename 落在既有目标上会 EPERM → 旧文件先让位（.mdp-bak）再改名后清除。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sha256Buffer, type ChunkedFile, type ChunkMeta } from './chunk.js';

export interface AssemblerOptions {
  finalPath: string;
  manifest: ChunkedFile;
  stagingPath?: string;
}

interface ReceivedState { fileSha256: string; received: number[] }

export class Assembler {
  readonly stagingPath: string;
  readonly #statePath: string;
  readonly #finalPath: string;
  readonly #manifest: ChunkedFile;
  readonly #received = new Set<number>();
  #fh?: fsp.FileHandle;
  #closed = false;

  constructor(opts: AssemblerOptions) {
    this.#finalPath = path.resolve(opts.finalPath);
    this.#manifest = opts.manifest;
    this.stagingPath = opts.stagingPath ?? this.#finalPath + '.mdp-part';
    this.#statePath = this.stagingPath + '.json';
  }

  /** 打开/续传：staging 存在则校验尺寸并恢复 received 集合；预分配到 manifest.size */
  async open(): Promise<void> {
    if (this.#closed) throw new Error('Assembler 已关闭');
    let resume = false;
    try {
      const st = JSON.parse(await fsp.readFile(this.#statePath, 'utf8')) as ReceivedState;
      if (st.fileSha256 === this.#manifest.fileSha256 && Array.isArray(st.received)) {
        for (const i of st.received) {
          const meta = this.#manifest.chunks[i];
          if (meta) this.#received.add(i); // 清单不符的索引丢弃（manifest 变更即全重来）
        }
        resume = fs.existsSync(this.stagingPath);
      }
    } catch { /* 无状态文件 = 全新 */ }

    this.#fh = await fsp.open(this.stagingPath, resume ? 'r+' : 'w');
    const cur = (await this.#fh.stat()).size;
    if (cur !== this.#manifest.size) await this.#fh.truncate(this.#manifest.size);
    if (resume && this.#received.size > 0) {
      console.log(`[assemble] 续传：已收 ${this.#received.size}/${this.#manifest.chunks.length} 块`);
    }
  }

  /** 已收块数（供进度/对账） */
  get receivedCount(): number { return this.#received.size; }

  /** 断点差量：尚未收到的块索引（升序） */
  missing(): number[] {
    const out: number[] = [];
    for (const c of this.#manifest.chunks) if (!this.#received.has(c.index)) out.push(c.index);
    return out;
  }

  /** 写入一块：先验 sha256（坏块拒收不污染 staging），幂等（重复投递跳过） */
  async writeChunk(meta: ChunkMeta, data: Buffer): Promise<{ written: boolean; reason?: string }> {
    if (this.#closed || !this.#fh) throw new Error('Assembler 未打开或已关闭');
    const expect = this.#manifest.chunks[meta.index];
    if (!expect) return { written: false, reason: `块索引越界：${meta.index}` };
    if (expect.sha256 !== meta.sha256) return { written: false, reason: `块 ${meta.index} 清单哈希不符` };
    if (this.#received.has(meta.index)) return { written: false, reason: 'already-received' };
    if (sha256Buffer(data) !== expect.sha256) return { written: false, reason: `块 ${meta.index} 数据哈希不符` };
    if (data.length !== expect.size) return { written: false, reason: `块 ${meta.index} 尺寸不符（${data.length}≠${expect.size}）` };
    await this.#fh.write(data, 0, data.length, expect.offset);
    this.#received.add(meta.index);
    await this.#persistState();
    return { written: true };
  }

  async #persistState(): Promise<void> {
    const st: ReceivedState = { fileSha256: this.#manifest.fileSha256, received: [...this.#received].sort((a, b) => a - b) };
    const tmp = this.#statePath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(st));
    await fsp.rename(tmp, this.#statePath);
  }

  /** finalize：全块到齐 → 关柄 → 按路径独立流式全量 sha256 校验（FileHandle 流的 autoClose/position 语义有坑，不直读句柄）→ 原子替换 → 清理状态 */
  async finalize(): Promise<{ finalPath: string; fileSha256: string; bytes: number }> {
    if (this.#closed || !this.#fh) throw new Error('Assembler 未打开或已关闭');
    const missing = this.missing();
    if (missing.length > 0) throw new Error(`缺少 ${missing.length} 块（如 ${missing.slice(0, 3).join(',')}）——finalize 前必须集齐`);
    await this.#fh.close();
    this.#fh = undefined;
    this.#closed = true;
    const hash = createHash('sha256');
    let bytes = 0;
    const rs = fs.createReadStream(this.stagingPath, { highWaterMark: 1024 * 1024 });
    for await (const c of rs) { hash.update(c as Buffer); bytes += (c as Buffer).length; }
    const actual = hash.digest('hex');
    if (actual !== this.#manifest.fileSha256) throw new Error(`全量校验失败：${actual} ≠ ${this.#manifest.fileSha256}`);
    await atomicReplace(this.stagingPath, this.#finalPath);
    await fsp.rm(this.#statePath, { force: true });
    return { finalPath: this.#finalPath, fileSha256: actual, bytes };
  }

  /** 静默关闭（保留 staging 与状态——断线/中断场景，续传时 open() 恢复 received） */
  async close(): Promise<void> {
    if (this.#fh) { await this.#fh.close().catch(() => {}); this.#fh = undefined; }
    this.#closed = true;
  }

  /** 中止：丢弃 staging 与状态（源副本不动） */
  async abort(): Promise<void> {
    if (this.#fh) { await this.#fh.close().catch(() => {}); this.#fh = undefined; }
    this.#closed = true;
    await fsp.rm(this.stagingPath, { force: true });
    await fsp.rm(this.#statePath, { force: true });
  }
}

/** 原子替换：目标存在时先让位（Windows rename 不覆盖既有文件） */
export const atomicReplace = async (staging: string, final: string): Promise<void> => {
  try {
    await fsp.rename(staging, final);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'ENOENT') throw e;
  }
  const bak = final + '.mdp-bak';
  await fsp.rm(bak, { force: true });
  try { await fsp.rename(final, bak); } catch { /* 目标本就不存在 */ }
  await fsp.rename(staging, final);
  await fsp.rm(bak, { force: true });
};
