/**
 * @mdp/contract 单元测试：信封形态、ids 唯一性、overlay 预设、manifest 可构造性。
 * Journal 对账裁决的实现在 @mdp/node（contract 只定义类型），其行为由 V5 集成测试覆盖。
 * 运行：npm run build -w @mdp/contract && npm test -w @mdp/contract
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelope } from '../envelope.js';
import { newCallId, newJobId, newTransferId } from '../ids.js';
import { FULL_ACCESS } from '../overlay.js';
import type { NodeManifest, ResultEnvelope } from '../index.js';

test('envelope：最小合法形态（helper 保证 hub 签发字段齐全）', () => {
  const e = envelope({ status: 'ok', node_id: 'pc2', call_id: 'c-1', ts_hub: 123 });
  assert.equal(e.status, 'ok');
  assert.equal(e.node_id, 'pc2');
  assert.equal(e.error, undefined);
  assert.equal(e.result, undefined);
});

test('envelope：denied 完整形态——permission 类 + 不可重试 + 拒绝原文', () => {
  const e: ResultEnvelope = {
    status: 'denied', node_id: 'pc2', call_id: 'c-2', ts_hub: 1,
    error: { class: 'permission', retryable: false, message: 'rm -rf 需审批' },
  };
  assert.equal(e.error!.class, 'permission');
  assert.equal(e.error!.retryable, false);
  assert.match(e.error!.message, /rm -rf/);
});

test('envelope：unknown 必须携带对账指引（禁止 LLM 重发，01 §4.3）', () => {
  const e: ResultEnvelope = {
    status: 'unknown', node_id: 'pc2', call_id: 'c-3', ts_hub: 1,
    error: { class: 'network', retryable: false, message: '对账指引' },
  };
  assert.equal(e.status, 'unknown');
  assert.equal(e.error!.retryable, false);
});

test('ids：前缀正确且不重复', () => {
  assert.ok(newCallId().startsWith('c-'));
  assert.ok(newJobId().startsWith('j-'));
  assert.ok(newTransferId().startsWith('t-'));
  assert.notEqual(newCallId(), newCallId());
});

test('overlay：full_access 预设是显式逃生门形态（content_gate=off）', () => {
  assert.equal(FULL_ACCESS.content_gate, 'off');
  assert.deepEqual(FULL_ACCESS.path_domains, ['*']);
  assert.equal(FULL_ACCESS.levels.exec, 'full');
});

test('manifest：最小节点上报可构造（01 §3.4）', () => {
  const m: NodeManifest = {
    manifest_version: 3,
    node_id: 'a'.repeat(16),
    display_name: 'pc2',
    os: 'win11', arch: 'x64', shell: 'powershell',
    agent_version: '0.1.0',
    capabilities: ['exec', 'fs'],
    workspaces: [{ name: 'repo', path: 'C:/Data/repo', revision: 1, workspace_id: 'w-1', superseded: false }],
    available: 'session',
    native_enforcement: 'none',
    self_description: {
      structured: { levels: { fs: 'workspaces', exec: 'allowlist', transfer: 'workspaces' }, path_domains: ['workspace:*'], command_patterns_allow: [] },
      text: '',
    },
  };
  assert.equal(m.workspaces[0]!.name, 'repo');
  assert.equal(m.native_enforcement, 'none');
});
