import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chunkFile, sha256Buffer, CHUNK_SIZE } from '../chunk.js';
import { Assembler, atomicReplace } from '../assemble.js';

const tmpRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-p2-'));
const readAll = async (p: string) => await fsp.readFile(p);
const mkPayload = (len: number): Buffer => {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
};

test('chunkFile：分块清单（尾块不满/空文件）', async () => {
  const root = tmpRoot();
  try {
    const big = path.join(root, 'big.bin');
    const payload = Buffer.alloc(CHUNK_SIZE + 123456);
    for (let i = 0; i < payload.length; i += 4096) payload.writeUInt32BE(i, i);
    fs.writeFileSync(big, payload);
    const m = await chunkFile(big);
    assert.equal(m.size, payload.length);
    assert.equal(m.chunks.length, 2);
    assert.equal(m.chunks[0]!.size, CHUNK_SIZE);
    assert.equal(m.chunks[1]!.size, payload.length - CHUNK_SIZE);
    assert.equal(m.fileSha256, sha256Buffer(payload));
    for (const c of m.chunks) assert.equal(c.sha256, sha256Buffer(payload.subarray(c.offset, c.offset + c.size)));
    const empty = path.join(root, 'empty.bin');
    fs.writeFileSync(empty, '');
    const me = await chunkFile(empty);
    assert.equal(me.size, 0);
    assert.equal(me.chunks.length, 0);
    assert.equal(me.fileSha256, sha256Buffer(Buffer.alloc(0)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('round-trip：乱序投递 → 字节一致 + staging/状态清理', async () => {
  const root = tmpRoot();
  try {
    const src = path.join(root, 'src.bin');
    const payload = mkPayload(3 * CHUNK_SIZE + 777);
    fs.writeFileSync(src, payload);
    const m = await chunkFile(src);
    const final = path.join(root, 'dst.bin');
    const a = new Assembler({ finalPath: final, manifest: m });
    await a.open();
    const order = [...m.chunks].sort((x, y) => (y.index % 2) - (x.index % 2) || x.index - y.index); // 偶数块先投
    const datas = new Map(m.chunks.map((c) => [c.index, payload.subarray(c.offset, c.offset + c.size)]));
    for (const c of order) {
      const r = await a.writeChunk(c, datas.get(c.index)!);
      assert.equal(r.written, true);
    }
    assert.equal(a.receivedCount, m.chunks.length);
    const r = await a.finalize();
    assert.equal(r.bytes, payload.length);
    assert.equal(r.fileSha256, m.fileSha256);
    assert.equal((await readAll(final)).compare(payload), 0);
    assert.ok(!fs.existsSync(final + '.mdp-part'));
    assert.ok(!fs.existsSync(final + '.mdp-part.json'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('坏块拒收：不污染 staging、不标记已收', async () => {
  const root = tmpRoot();
  try {
    const src = path.join(root, 'src3.bin');
    const payload = mkPayload(2 * CHUNK_SIZE);
    fs.writeFileSync(src, payload);
    const m = await chunkFile(src);
    const final = path.join(root, 'dst3.bin');
    const a = new Assembler({ finalPath: final, manifest: m });
    await a.open();
    // 正确块 0
    assert.equal((await a.writeChunk(m.chunks[0]!, payload.subarray(0, CHUNK_SIZE))).written, true);
    // 坏数据块 1：哈希不符
    const bad = mkPayload(CHUNK_SIZE); bad[0] = (bad[0] ?? 0) ^ 0xff;
    const r1 = await a.writeChunk(m.chunks[1]!, bad);
    assert.equal(r1.written, false);
    assert.match(r1.reason ?? '', /数据哈希不符/);
    assert.equal(a.receivedCount, 1);
    // 幂等：块 0 重复投递
    const r2 = await a.writeChunk(m.chunks[0]!, payload.subarray(0, CHUNK_SIZE));
    assert.equal(r2.written, false);
    assert.match(r2.reason ?? '', /already-received/);
    // staging 上块 1 的区域未被污染（应保持预分配的零）
    const handle = await fsp.open(a.stagingPath, 'r');
    const probe = Buffer.alloc(16);
    await handle.read(probe, 0, 16, CHUNK_SIZE);
    await handle.close();
    assert.ok(probe.every((b) => b === 0));
    await a.abort();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('断点续传：静默中断 → 状态恢复 → 差量续齐 → finalize', async () => {
  const root = tmpRoot();
  try {
    const src = path.join(root, 'src4.bin');
    const payload = mkPayload(5 * CHUNK_SIZE + 1);
    fs.writeFileSync(src, payload);
    const m = await chunkFile(src);
    const final = path.join(root, 'dst4.bin');
    const datas = new Map(m.chunks.map((c) => [c.index, payload.subarray(c.offset, c.offset + c.size)]));

    // 第一程：投 0/2/4 后静默关闭（模拟断线，staging 与状态留存）
    const a1 = new Assembler({ finalPath: final, manifest: m });
    await a1.open();
    for (const i of [0, 2, 4]) await a1.writeChunk(m.chunks[i]!, datas.get(i)!);
    await a1.close();

    // 第二程：新 Assembler 恢复 → 差量 = 1/3/5 → 续齐 → finalize
    const a2 = new Assembler({ finalPath: final, manifest: m });
    await a2.open();
    assert.equal(a2.receivedCount, 3, '状态恢复');
    assert.deepEqual(a2.missing(), [1, 3, 5]);
    for (const i of [5, 1, 3]) await a2.writeChunk(m.chunks[i]!, datas.get(i)!);
    const r = await a2.finalize();
    assert.equal(r.fileSha256, m.fileSha256);
    assert.equal((await readAll(final)).compare(payload), 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('finalize 缺块拒绝 + 覆盖既有目标（原子替换含 Windows 让位）+ 空文件', async () => {
  const root = tmpRoot();
  try {
    const src = path.join(root, 'src5.bin');
    const payload = mkPayload(2 * CHUNK_SIZE);
    fs.writeFileSync(src, payload);
    const m = await chunkFile(src);
    const final = path.join(root, 'dst5.bin');
    // 预置旧目标 → 验证 Windows rename 让位逻辑
    fs.writeFileSync(final, 'OLD-CONTENT');
    const datas = new Map(m.chunks.map((c) => [c.index, payload.subarray(c.offset, c.offset + c.size)]));

    const a = new Assembler({ finalPath: final, manifest: m });
    await a.open();
    await assert.rejects(() => a.finalize(), /缺少 2 块/); // 未集齐拒绝
    for (const c of m.chunks) await a.writeChunk(c, datas.get(c.index)!);
    await a.finalize();
    assert.equal((await readAll(final)).compare(payload), 0, '旧内容被原子替换');
    assert.ok(!fs.existsSync(final + '.mdp-bak'));

    // 空文件：零块清单 → open+finalize 直达
    const empty = path.join(root, 'empty.bin');
    fs.writeFileSync(empty, '');
    const me = await chunkFile(empty);
    const ef = path.join(root, 'dst-empty.bin');
    const ae = new Assembler({ finalPath: ef, manifest: me });
    await ae.open();
    const re = await ae.finalize();
    assert.equal(re.bytes, 0);
    assert.ok(fs.existsSync(ef));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('atomicReplace：Windows 让位舞步单测', async () => {
  const root = tmpRoot();
  try {
    const staging = path.join(root, 's.bin');
    const final = path.join(root, 'f.bin');
    fs.writeFileSync(staging, 'NEW');
    fs.writeFileSync(final, 'OLD');
    await atomicReplace(staging, final);
    assert.equal((await readAll(final)).toString(), 'NEW');
    assert.ok(!fs.existsSync(staging));
    assert.ok(!fs.existsSync(final + '.mdp-bak'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
