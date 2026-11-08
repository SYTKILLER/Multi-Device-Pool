import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAnnounce, parseAnnounce, ANNOUNCE_MAX_BYTES, type AnnouncePayload } from '../protocol.js';
import { UnicastAnnounceServer, announceUnicast } from '../unicast.js';
import { MulticastAnnouncer, MulticastBrowser } from '../multicast.js';
import { listLanIfaces } from '../ifaces.js';

const hubAnnounce = (id = 'hubfp01'): AnnouncePayload => ({
  proto: 'mdp/1', kind: 'announce_reply', role: 'hub', name: 'hub-test', id, tcpPort: 7900, epoch: 1, ts: Date.now(),
});
const nodeAnnounce = (id = 'node01'): AnnouncePayload => ({
  proto: 'mdp/1', kind: 'announce', role: 'node', name: 'pc2', id, tcpPort: 7900, ts: Date.now(),
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('protocol：合法/垃圾/超限报文', () => {
  assert.equal(parseAnnounce(encodeAnnounce(nodeAnnounce()))?.id, 'node01');
  assert.equal(parseAnnounce(Buffer.from('not json')), null);
  assert.equal(parseAnnounce(Buffer.from('{"proto":"mdp/0"}')), null);
  assert.equal(parseAnnounce(Buffer.alloc(ANNOUNCE_MAX_BYTES + 1, 0x7b)), null);
  const oversized = nodeAnnounce(); oversized.name = 'x'.repeat(2000);
  assert.throws(() => encodeAnnounce(oversized));
});

test('unicast：roundtrip（hub reply 按 filter 校验返回）', async () => {
  const server = new UnicastAnnounceServer({
    port: 0,
    onAnnounce: (p, _remote, reply) => {
      assert.equal(p.role, 'node');
      reply(hubAnnounce());
    },
  });
  const port = await server.start();
  try {
    const reply = await announceUnicast({
      host: '127.0.0.1', port, payload: nodeAnnounce(),
      filter: (r) => r.role === 'hub' && r.id === 'hubfp01',
    });
    assert.ok(reply, '应收到 reply');
    assert.equal(reply.id, 'hubfp01');
    assert.equal(reply.epoch, 1);
  } finally { server.stop(); }
});

test('unicast：首包被吞 → 重试后成功', async () => {
  let seen = 0;
  const server = new UnicastAnnounceServer({
    port: 0,
    onAnnounce: (_p, _r, reply) => {
      seen += 1;
      if (seen >= 2) reply(hubAnnounce('retryhub'));
    },
  });
  const port = await server.start();
  try {
    const reply = await announceUnicast({ host: '127.0.0.1', port, payload: nodeAnnounce(), retries: 3, gapMs: 50, timeoutMs: 200 });
    assert.ok(reply, '重试后应成功');
    assert.equal(reply.id, 'retryhub');
    assert.ok(seen >= 2);
  } finally { server.stop(); }
});

test('unicast：目标不存在 → 耗尽返回 null（回退手输地址语义）', async () => {
  const reply = await announceUnicast({ host: '127.0.0.1', port: 59999, payload: nodeAnnounce(), retries: 2, gapMs: 20, timeoutMs: 60 });
  assert.equal(reply, null);
});

test('multicast：同机 announce→browser 发现（显式绑接口，V3 约束）', { skip: listLanIfaces().length === 0 ? '无非 internal IPv4 接口' : false }, async () => {
  let resolveFound!: (v: boolean) => void;
  const found = new Promise<boolean>((r) => { resolveFound = r; });
  const browser = new MulticastBrowser({
    ttlMs: 6000,
    filter: (p) => p.role === 'node' && p.id === 'mc-node01',
    onEntry: (p) => { if (p.id === 'mc-node01') resolveFound(true); },
  });
  const joined = await browser.start();
  const announcer = new MulticastAnnouncer({ payload: nodeAnnounce('mc-node01'), intervalMs: 200 });
  announcer.start();
  try {
    const ok = await Promise.race([found, sleep(5000).then(() => false)]);
    assert.equal(ok, true, `5s 内未发现（加组接口数=${joined}）`);
  } finally { announcer.stop(); browser.stop(); }
});

test('multicast：dedup 与 TTL 过期后再次 isNew', { skip: listLanIfaces().length === 0 ? '无非 internal IPv4 接口' : false }, async () => {
  let isNewTrue = 0, total = 0, downSeen = 0;
  const browser = new MulticastBrowser({
    ttlMs: 600,                    // sweeper 自适应为 300ms 一跳
    filter: (p) => p.role === 'node' && p.id === 'mc-dedup01',
    onEntry: (_p, _r, isNew) => { total += 1; if (isNew) isNewTrue += 1; },
    onDown: () => { downSeen += 1; },
  });
  await browser.start();
  const announcer = new MulticastAnnouncer({ payload: nodeAnnounce('mc-dedup01'), intervalMs: 150 });
  // 时间线：0-1000ms 连续广播（首见 1 次，其余 dedup）→ 停 1000ms（过 TTL → onDown）→ 复播（再首见）→ 收
  announcer.start();
  await sleep(1000);
  announcer.stop();
  await sleep(1000);
  announcer.start();
  await sleep(600);
  announcer.stop();
  await sleep(700);                // 留 sweeper 最后一跳触发 onDown
  browser.stop();
  assert.ok(isNewTrue >= 2, `首见+过期后再首见应≥2，实际=${isNewTrue}`);
  assert.ok(total > isNewTrue, `dedup 应生效：total=${total} 应大于 isNew=${isNewTrue}`);
  assert.ok(downSeen >= 1, `应观察到下线事件，实际=${downSeen}`);
});
