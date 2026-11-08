/**
 * contract 0.2.0 新增面单测：audit 哈希链算法（node 写入与 hub 校验必须逐字节一致）+
 * discovery 常量/载荷形态。P1-5/P1-7 的正确性锚点。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultHash, auditHash, verifyAuditChain, AUDIT_GENESIS, ANNOUNCE_GROUP, ANNOUNCE_PORT, ANNOUNCE_UNICAST_PORT, ANNOUNCE_MAX_BYTES, type AuditRecord } from '../index.js';

const mkRecord = (seq: number, prev: string, exit: number): Omit<AuditRecord, 'hash'> => ({
  seq,
  ts: '2026-11-09T00:00:0' + seq + '.000Z',
  call_id: `c-${seq}`,
  kind: 'exec',
  cmd: `echo ${seq}`,
  exit,
  result_hash: resultHash(`out${seq}`, `err${seq}`, exit),
  prev_hash: prev,
});

test('resultHash：确定性 + 输入敏感（stdout/stderr/exit 任一变化即变）', () => {
  const a = resultHash('o', 'e', 0);
  assert.equal(a, resultHash('o', 'e', 0));
  assert.notEqual(a, resultHash('o ', 'e', 0));
  assert.notEqual(a, resultHash('o', 'e ', 0));
  assert.notEqual(a, resultHash('o', 'e', 1));
  assert.equal(a.length, 64);
});

test('auditHash：固定序拼串——字段重排不影响、值变化必变', () => {
  const r = mkRecord(1, AUDIT_GENESIS, 0);
  const h1 = auditHash(r);
  // 同字段不同构造顺序（TS 对象字面量同序，这里用展开重排验证拼串不受对象键序影响）
  const reordered = { prev_hash: r.prev_hash, result_hash: r.result_hash, exit: r.exit, op: r.op, cmd: r.cmd, kind: r.kind, call_id: r.call_id, ts: r.ts, seq: r.seq };
  assert.equal(auditHash(reordered), h1);
  assert.notEqual(h1, auditHash({ ...r, exit: 1 }));
  assert.notEqual(h1, auditHash({ ...r, prev_hash: 'f'.repeat(64) }));
});

test('verifyAuditChain：3 记录链通过；篡改中间记录 → brokenAt 指向被改 seq', () => {
  const r1 = { ...mkRecord(1, AUDIT_GENESIS, 0), hash: '' };
  r1.hash = auditHash(r1);
  const r2 = { ...mkRecord(2, r1.hash, 1), hash: '' };
  r2.hash = auditHash(r2);
  const r3 = { ...mkRecord(3, r2.hash, 0), hash: '' };
  r3.hash = auditHash(r3);

  assert.deepEqual(verifyAuditChain([r1, r2, r3], AUDIT_GENESIS), { ok: true });

  const tampered: AuditRecord = { ...r2, exit: 999 }; // 回溯性篡改（hash 不重算）
  const v = verifyAuditChain([r1, tampered, r3], AUDIT_GENESIS);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
  assert.match(v.reason ?? '', /篡改/);

  // prev 断链（删改中间记录导致链接不上）
  const v2 = verifyAuditChain([r1, r3], AUDIT_GENESIS);
  assert.equal(v2.ok, false);
  assert.equal(v2.brokenAt, 3);
});

test('discovery 常量与 V3 定论/契约请求一致', () => {
  assert.equal(ANNOUNCE_GROUP, '239.255.77.68');
  assert.equal(ANNOUNCE_PORT, 53550);
  assert.equal(ANNOUNCE_UNICAST_PORT, 7900); // 与 TCP 节点端点同号
  assert.equal(ANNOUNCE_MAX_BYTES, 1024);
  assert.equal(AUDIT_GENESIS, '0'.repeat(64));
});
