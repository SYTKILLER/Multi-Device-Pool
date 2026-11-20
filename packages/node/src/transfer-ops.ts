/**
 * 节点侧 transfer 执行器（P2-1 接线）：把 @mdp/transfer 的 chunker/assembler
 * 挂到 nodeproto 混合帧上。
 * - receive：transfer_receive 调用开组装器（stream=call_id 的 bin 帧喂块），
 *   帧到齐 → 集齐自动 finalize（原子替换），缺块/坏块给出差量（hub 按差量重流，幂等）。
 * - send：transfer_send 回 manifest 信封后流 bin 帧（两遍读：第一遍 chunkFile 定清单，
 *   第二遍按清单逐块读+验哈希——文件传输中变更即中止）。only 参数支持差量重发。
 * 断线安全：pauseAll 关柄但保 staging/状态文件，重连后同名 transfer_id 续传。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Assembler, chunkFile, sha256Buffer } from '@mdp/transfer';
import type { ChunkedFile, TransferOutcome, TransferReceiveParams } from '@mdp/contract';

interface RxEntry {
  params: TransferReceiveParams;
  abs: string;
  assembler?: Assembler;
  /** 组装器就绪前到达的帧（TCP 保序：bin 帧晚于 call 行，但 dispatch 处理含 await，需排队） */
  queue: Array<{ seq: number; data: Buffer }>;
  ready: boolean;
  framesSeen: number;
  queuedBytes: number;
  rejected: Array<{ index: number; reason: string }>;
  responded: boolean;
  startedMarked: boolean;
  draining: boolean; // #drain 单飞锁（防双 drain 并发撞 close——2026-11-21 竞速修复）
  resolve: (outcome: TransferOutcome & { failed?: string }) => void;
}

const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

export class TransferManager {
  #active = new Map<string, RxEntry>(); // key: call_id（bin 帧的 stream）

  /** 开始接收（agent 已过 overlay 门）。返回最终 TransferOutcome；failed 非空表示未完成 */
  async receive(callId: string, params: TransferReceiveParams, abs: string, onFirstChunk: () => void): Promise<TransferOutcome & { failed?: string }> {
    const manifest = params.manifest;
    if (!manifest || !Array.isArray(manifest.chunks) || typeof manifest.size !== 'number' || typeof manifest.fileSha256 !== 'string') {
      return { transfer_id: params.transfer_id, file_sha256: '', bytes: 0, chunks: 0, failed: 'manifest 非法' };
    }
    const entry: RxEntry = {
      params, abs, queue: [], ready: false, framesSeen: 0, queuedBytes: 0, rejected: [], responded: false, startedMarked: false, draining: false,
      resolve: () => {},
    };
    const done = new Promise<TransferOutcome & { failed?: string }>((resolve) => { entry.resolve = resolve; });
    this.#active.set(callId, entry);
    try {
      await fsp.mkdir(path.dirname(abs), { recursive: true }); // 目标子目录可不存在（fs write 同义：建父目录）
      entry.assembler = new Assembler({ finalPath: abs, manifest });
      await entry.assembler.open();
    } catch (e) {
      this.#active.delete(callId);
      return { transfer_id: params.transfer_id, file_sha256: manifest.fileSha256, bytes: 0, chunks: manifest.chunks.length, failed: `组装器打开失败：${String((e as Error).message)}` };
    }
    if (manifest.chunks.length === 0) {
      // 空文件：零块清单，无帧会来，直接 finalize
      try {
        const fin = await entry.assembler.finalize();
        this.#active.delete(callId);
        return { transfer_id: params.transfer_id, file_sha256: fin.fileSha256, bytes: 0, chunks: 0 };
      } catch (e) {
        this.#active.delete(callId);
        return { transfer_id: params.transfer_id, file_sha256: manifest.fileSha256, bytes: 0, chunks: 0, failed: `finalize 失败：${String((e as Error).message)}` };
      }
    }
    entry.ready = true;
    await this.#drain(callId, entry, onFirstChunk);
    return await done;
  }

  /** bin 帧喂入（agent 的 WireDecoder onBin 路由到这里；未知 stream 静默丢弃=迟到/重复帧） */
  feed(stream: string, seq: number, data: Buffer, onFirstChunk: () => void): void {
    const entry = this.#active.get(stream);
    if (!entry || entry.responded) return;
    entry.queue.push({ seq, data });
    entry.queuedBytes += data.length;
    if (entry.queuedBytes > MAX_QUEUED_BYTES) {
      entry.responded = true;
      void entry.assembler?.abort();
      this.#active.delete(stream);
      entry.resolve({ transfer_id: entry.params.transfer_id, file_sha256: entry.params.manifest.fileSha256, bytes: 0, chunks: entry.params.manifest.chunks.length, failed: '接收队列超限（节点阻塞过久）' });
      return;
    }
    void this.#drain(stream, entry, onFirstChunk);
  }

  async #drain(stream: string, entry: RxEntry, onFirstChunk: () => void): Promise<void> {
    // 单飞锁：feed 在 drain await writeChunk 挂起期间再到达时只入队，由在跑的循环消费；
    // 否则双 drain 并发——先完成者 finalize/pauseAll 关流，后到者 writeChunk 撞 close 即
    // unhandled rejection 杀 node（hub 侧同款竞速 2026-11-21 V6 间歇崩抓到并修复）
    if (entry.draining || !entry.ready) return;
    entry.draining = true;
    try {
      const chunks = entry.params.manifest.chunks;
      while (entry.queue.length > 0 && !entry.responded) {
        const { seq, data } = entry.queue.shift()!;
        entry.queuedBytes -= data.length;
        entry.framesSeen += 1;
        if (!entry.startedMarked) { entry.startedMarked = true; onFirstChunk(); }
        const meta = chunks[seq];
        if (!meta) {
          entry.rejected.push({ index: seq, reason: '块索引越界' });
        } else {
          try {
            const r = await entry.assembler!.writeChunk(meta, data);
            if (!r.written && r.reason !== 'already-received') entry.rejected.push({ index: seq, reason: r.reason ?? '未知拒收' });
          } catch (e) {
            // 迟滞块撞上 finalize/pauseAll/abort 关闭：丢弃入 rejected（错误信封原则——传输层竞速不是进程级故障）
            entry.rejected.push({ index: seq, reason: `writeChunk 异常丢弃：${String((e as Error).message)}` });
            continue;
          }
        }
        // 集齐即 finalize（不待帧尾——最后一块写成功即完整）
        if (entry.assembler!.receivedCount === chunks.length) {
          entry.responded = true;
          try {
            const fin = await entry.assembler!.finalize();
            this.#active.delete(stream);
            entry.resolve({ transfer_id: entry.params.transfer_id, file_sha256: fin.fileSha256, bytes: fin.bytes, chunks: chunks.length });
          } catch (e) {
            // 全量校验失败=数据级损坏：保 staging 供排查，按缺块差量报（重流无法修复哈希不符，如实失败）
            this.#active.delete(stream);
            entry.resolve({ transfer_id: entry.params.transfer_id, file_sha256: entry.params.manifest.fileSha256, bytes: 0, chunks: chunks.length, failed: `finalize 失败：${String((e as Error).message)}`, missing: entry.assembler!.missing() });
          }
          return;
        }
      }
      // 帧到齐但未集齐 → 差量报告（零块清单在 receive() 已短路，此分支只对有块传输生效）
      if (chunks.length > 0 && entry.framesSeen >= chunks.length && !entry.responded) {
        entry.responded = true;
        const missing = entry.assembler!.missing();
        await entry.assembler!.close(); // 保 staging 续传
        this.#active.delete(stream);
        entry.resolve({
          transfer_id: entry.params.transfer_id, file_sha256: entry.params.manifest.fileSha256,
          bytes: 0, chunks: chunks.length, missing, rejected: entry.rejected,
          failed: `块未集齐（缺 ${missing.length}，拒收 ${entry.rejected.length}）——hub 按差量重流`,
        });
      }
    } finally {
      entry.draining = false;
      // 尾检：drain 收尾（同步段）与新 feed 的 push 在单线程下不交错；此处补启动覆盖
      // "上一循环退出后、本 finally 前无新 drain 启动"的滞留窗口
      if (entry.queue.length > 0 && !entry.responded && entry.ready && this.#active.has(stream)) void this.#drain(stream, entry, onFirstChunk);
    }
  }

  /** 断连：全部在途接收关柄保 staging（续传），放弃未完成响应 */
  pauseAll(): void {
    for (const [stream, entry] of this.#active) {
      void entry.assembler?.close();
      if (!entry.responded) {
        entry.responded = true;
        entry.resolve({ transfer_id: entry.params.transfer_id, file_sha256: entry.params.manifest.fileSha256, bytes: 0, chunks: entry.params.manifest.chunks.length, failed: '连接断开，staging 已保留待续传' });
      }
      this.#active.delete(stream);
    }
  }

  /**
   * 发送：按 manifest 逐块读文件（第二遍读，验哈希防中途变更），writeBin 由 agent 提供
   * （含背压 drain）。only = 差量重发索引集。
   */
  async send(callId: string, abs: string, manifest: ChunkedFile, only: number[] | undefined, writeBin: (header: { stream: string; seq: number; bytes: number }, payload: Buffer) => Promise<void>): Promise<void> {
    const fh = await fsp.open(abs, 'r');
    try {
      for (const idx of only ?? manifest.chunks.map((c) => c.index)) {
        const meta = manifest.chunks[idx];
        if (!meta) throw new Error(`块索引越界：${idx}`);
        const buf = Buffer.alloc(meta.size);
        await fh.read(buf, 0, meta.size, meta.offset);
        if (sha256Buffer(buf) !== meta.sha256) throw new Error(`文件在传输中变更（块 ${idx} 哈希不符）——中止发送`);
        await writeBin({ stream: callId, seq: idx, bytes: buf.length }, buf);
      }
    } finally {
      await fh.close();
    }
  }
}

/** 节点侧发送前取分块清单（库层 chunkFile，按路径流读——FileHandle 流 EBADF 坑的规避面） */
export const buildManifest = chunkFile;
