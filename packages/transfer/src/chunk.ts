/**
 * 分块器（P2-1，01 §5.2）：文件 → 1 MiB 分块清单，单遍流式同时算全文件与逐块 sha256。
 * 块清单即断点续传的依据（差量 = manifest.chunks − 已收块）。
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';

export const CHUNK_SIZE = 1024 * 1024;

export interface ChunkMeta { index: number; offset: number; size: number; sha256: string }
export interface ChunkedFile { size: number; fileSha256: string; chunkSize: number; chunks: ChunkMeta[] }

export const sha256Buffer = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

export const chunkFile = async (absPath: string, chunkSize = CHUNK_SIZE): Promise<ChunkedFile> => {
  const stream = fs.createReadStream(absPath, { highWaterMark: chunkSize });
  const fileHash = createHash('sha256');
  const chunks: ChunkMeta[] = [];
  let offset = 0;
  let index = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    fileHash.update(buf);
    chunks.push({ index, offset, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
    offset += buf.length;
    index += 1;
  }
  return { size: offset, fileSha256: fileHash.digest('hex'), chunkSize, chunks };
};
