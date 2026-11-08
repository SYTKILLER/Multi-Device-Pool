import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildManifest } from '../manifest.js';
import { parseIgnoreLines, matcher } from '../ignore.js';
import { secretPathHit, secretContentHit } from '../secrets.js';

const tmpRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-transfer-'));
const w = (root: string, rel: string, content: string | Buffer): string => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
};
const pathsOf = (xs: Array<{ path: string }>) => xs.map((x) => x.path);

test('ignore：gitignore-lite 子集语义', () => {
  const m = matcher(parseIgnoreLines('*.log\nbuild/\nsecret-dir'));
  assert.equal(m.matches('a/b/debug.log', false), true);
  assert.equal(m.matches('x/build', true), true);
  assert.equal(m.matches('x/build/y.js', true), true);          // 位于 build/ 目录下 → 剪枝
  assert.equal(m.matches('x/secret-dir', true), true);
  assert.equal(m.matches('keep.txt', false), false);
  assert.equal(matcher(parseIgnoreLines('# 注释\n\n!important')).matches('x', false), false); // 注释与取反跳过
});

test('secrets：路径规则与内容启发', async () => {
  assert.equal(secretPathHit('.env'), '.env 类环境文件');
  assert.equal(secretPathHit('config/.env.production'), '.env 类环境文件');
  assert.equal(secretPathHit('keys/server.pem'), '证书/密钥文件');
  assert.equal(secretPathHit('ssh/id_rsa_backup'), 'SSH 私钥');
  assert.equal(secretPathHit('hello.txt'), null);
  const tmp = tmpRoot();
  try {
    const pem = w(tmp, 'k.pem', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n');
    assert.equal(await secretContentHit(pem), '私钥块');
    const tok = w(tmp, 't.txt', 'token: sk-abcdefghij0123456789ABCD');
    assert.equal(await secretContentHit(tok), 'sk- 形态 API key');
    assert.equal(await secretContentHit(w(tmp, 'clean.txt', '普通内容没有任何密钥')), null);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('manifest：端到端分桶（体积/秘密/内容/lockfile）+ sha256 正确 + exec 位记录', async () => {
  const root = tmpRoot();
  const outside = path.join(path.dirname(root), 'outside-secret.txt');
  fs.writeFileSync(outside, 'outside');
  try {
    w(root, 'hello.txt', 'hello world');
    w(root, 'sub/nested.txt', 'nested');
    w(root, '.env', 'SECRET=1');
    w(root, 'certs/server.pem', '-----BEGIN PRIVATE KEY-----\nxx\n');
    w(root, 'token.txt', 'key = sk-abcdefghij0123456789ABCD');
    w(root, 'node_modules/pkg/index.js', 'x');
    w(root, 'sub/debug.log', 'log');
    w(root, 'sub/.gitignore', '*.log\n');
    w(root, 'editor.swp', 'swap');
    w(root, 'Cargo.lock', 'lockfile-is-legit-content');
    fs.symlinkSync(path.join(root, 'hello.txt'), path.join(root, 'link-internal'));
    let symlinkOK = true;
    try { fs.symlinkSync(outside, path.join(root, 'link-out')); } catch { symlinkOK = false; } // Windows 需开发者模式

    const m = await buildManifest(root);
    const fp = pathsOf(m.files);
    const ep = pathsOf(m.excluded);

    assert.deepEqual(fp, ['Cargo.lock', 'hello.txt', 'sub/.gitignore', 'sub/nested.txt']); // .gitignore/Cargo.lock 是合法项目文件
    assert.ok(!ep.includes('Cargo.lock'));
    assert.ok(!ep.includes('node_modules') || ep.includes('node_modules/'));
    assert.ok(ep.includes('node_modules/'));
    assert.ok(ep.includes('sub/debug.log'));
    assert.ok(ep.includes('.env'));
    assert.ok(ep.includes('certs/server.pem'));
    assert.ok(ep.includes('token.txt'));
    assert.ok(ep.includes('editor.swp'));
    const byPath = Object.fromEntries(m.excluded.map((e) => [e.path, e.reason]));
    assert.equal(byPath['.env'], 'secret');
    assert.equal(byPath['certs/server.pem'], 'secret');
    assert.equal(byPath['token.txt'], 'secret-content');
    assert.equal(byPath['editor.swp'], 'lockfile');
    assert.equal(byPath['node_modules/'], 'ignore');
    assert.equal(byPath['sub/debug.log'], 'ignore');
    // refs：内链进 refs；外链进 refs + excluded（symlink-out）
    const refIn = m.refs.find((r) => r.path === 'link-internal');
    assert.ok(refIn && refIn.insideRoot && !refIn.target.includes('outside'));
    if (symlinkOK) {
      assert.ok(m.refs.some((r) => r.path === 'link-out' && r.insideRoot === false));
      assert.equal(byPath['link-out'], 'symlink-out');
    }
    // sha256 正确性（对 hello.txt 手工比对）
    const { createHash } = await import('node:crypto');
    const hello = m.files.find((f) => f.path === 'hello.txt')!;
    assert.equal(hello.sha256, createHash('sha256').update('hello world').digest('hex'));
    assert.equal(hello.size, 11);
    assert.ok(m.totalBytes >= 11 + 6);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('manifest：extraIgnore 与空目录容错', async () => {
  const root = tmpRoot();
  try {
    w(root, 'a.tmpfile', 'x');
    w(root, 'keep.txt', 'y');
    const m = await buildManifest(root, { extraIgnore: ['*.tmpfile'] });
    assert.deepEqual(pathsOf(m.files), ['keep.txt']);
    assert.ok(m.excluded.some((e) => e.path === 'a.tmpfile'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  // 不可读目录：整体按 ignore 退出而非抛错（Windows 的 chmod 无法制造不可读目录，仅 POSIX 验证）
  if (process.platform !== 'win32') {
    const root2 = tmpRoot();
    try {
      const sub = path.join(root2, 'locked');
      fs.mkdirSync(sub);
      await fsp.chmod(sub, 0o000).catch(() => {});
      const m = await buildManifest(root2);
      assert.ok(m.excluded.some((e) => e.path === 'locked/' || e.path === './'));
      await fsp.chmod(sub, 0o755).catch(() => {});
    } finally { fs.rmSync(root2, { recursive: true, force: true }); }
  }
});
