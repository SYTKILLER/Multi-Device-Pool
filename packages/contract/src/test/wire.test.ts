import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WireDecoder, encodeControlFrame, encodeBinFrame, MAX_BIN_FRAME_BYTES } from '../wire.js';

/** 把任意 Buffer 序列喂给解码器（模拟 TCP 任意分段） */
const feed = (dec: WireDecoder, bufs: Buffer[]) => bufs.forEach((b) => dec.push(b));

test('wire：控制帧往返（含中文）', () => {
  const frames: Record<string, unknown>[] = [];
  const dec = new WireDecoder({ onFrame: (m) => frames.push(m), onBin: () => assert.fail('不应有 bin'), onViolation: () => assert.fail('不应违规') });
  feed(dec, [encodeControlFrame({ t: 'call', kind: 'exec', note: '中文回显验证' })]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!['kind'], 'exec');
});

test('wire：bin 帧往返 + 净荷含 \\n 与形似 JSON 字节', () => {
  const bins: Array<{ h: unknown; p: Buffer }> = [];
  const dec = new WireDecoder({ onFrame: () => {}, onBin: (h, p) => bins.push({ h, p }), onViolation: (r) => assert.fail(r) });
  // 净荷：全 256 字节值 + 恶意形似内容（头部行/尾哨兵混淆尝试）
  const payload = Buffer.concat([
    Buffer.from([0, 1, 10, 13, 123, 34, 116, 58, 34, 98, 105, 110, 34, 125]), // {"t":"bin"} + \r\n 字节
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    Buffer.from('\n{"t":"bin","stream":"x"}\n', 'utf8'),
  ]);
  feed(dec, [encodeBinFrame({ stream: 'c-1', seq: 3, bytes: payload.length }, payload)]);
  assert.equal(bins.length, 1);
  assert.equal((bins[0]!.h as { stream: string }).stream, 'c-1');
  assert.equal((bins[0]!.h as { seq: number }).seq, 3);
  assert.ok(bins[0]!.p.equals(payload), '净荷逐字节一致');
});

test('wire：多帧交错 + 任意 TCP 分段（逐字节喂入）', () => {
  const frames: string[] = [];
  const bins: Buffer[] = [];
  const dec = new WireDecoder({ onFrame: (m) => frames.push(String(m['t'])), onBin: (_h, p) => bins.push(p), onViolation: (r) => assert.fail(r) });
  const p1 = Buffer.from('a\nb\nc', 'utf8');
  const p2 = Buffer.alloc(1000, 0x5a);
  const stream = Buffer.concat([
    encodeControlFrame({ t: 'hello' }),
    encodeBinFrame({ stream: 's1', seq: 0, bytes: p1.length }, p1),
    encodeControlFrame({ t: 'ping' }),
    encodeBinFrame({ stream: 's1', seq: 1, bytes: p2.length }, p2),
    encodeControlFrame({ t: 'pong' }),
  ]);
  // 最恶劣分段：一次 1 字节
  for (const b of stream) feed(dec, [Buffer.from([b])]);
  assert.deepEqual(frames, ['hello', 'ping', 'pong']);
  assert.equal(bins.length, 2);
  assert.ok(bins[0]!.equals(p1) && bins[1]!.equals(p2));
});

test('wire：哨兵缺失 → violation', () => {
  let violated = '';
  const dec = new WireDecoder({ onFrame: () => {}, onBin: () => {}, onViolation: (r) => { violated = r; } });
  const head = Buffer.from(JSON.stringify({ t: 'bin', stream: 's', seq: 0, bytes: 3 }) + '\n', 'utf8');
  feed(dec, [head, Buffer.from('abcX')]); // 尾字节非 \n
  assert.match(violated, /哨兵缺失/);
});

test('wire：bin 头超限 → violation（不下洞等净荷）', () => {
  let violated = '';
  const dec = new WireDecoder({ onFrame: () => {}, onBin: () => {}, onViolation: (r) => { violated = r; } });
  feed(dec, [Buffer.from(JSON.stringify({ t: 'bin', stream: 's', seq: 0, bytes: MAX_BIN_FRAME_BYTES + 1 }) + '\n', 'utf8')]);
  assert.match(violated, /非法/);
});

test('wire：坏 JSON 行 → 以 __bad_json 透出（跳过不致命，兼容 P0 行为）', () => {
  const frames: Record<string, unknown>[] = [];
  const dec = new WireDecoder({ onFrame: (m) => frames.push(m), onBin: () => {}, onViolation: () => assert.fail() });
  feed(dec, [Buffer.from('not-json\n', 'utf8'), encodeControlFrame({ t: 'ok' })]);
  assert.equal(frames[0]!['t'], '__bad_json');
  assert.equal(frames[1]!['t'], 'ok');
});
