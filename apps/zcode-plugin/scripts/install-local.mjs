// P1-9 本地安装：把 mdp 插件镜像进 ZCode 官方缓存布局 + 注册表（marketplace 源仅支持 url/github，
// 本地目录安装走此脚本——幂等，可重复执行）。用法：node scripts/install-local.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const pluginSrc = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'mdp'); // apps/zcode-plugin/mdp
const pl = path.join(os.homedir(), '.zcode', 'cli', 'plugins');
const version = JSON.parse(fs.readFileSync(path.join(pluginSrc, 'package.json'), 'utf8')).version;
const cacheDir = path.join(pl, 'cache', 'mdp-local', 'mdp', version);
const id = `mdp@mdp-local`;
const now = new Date().toISOString();

// ① 缓存布局：cache/<marketplace>/<plugin>/<version>/（镜像 zcode-plugins-official 结构）
fs.rmSync(cacheDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
fs.cpSync(pluginSrc, cacheDir, { recursive: true, filter: (s) => !s.includes('node_modules') });
console.log(`[install] 缓存 → ${cacheDir}`);

// ② 注册表
const regPath = path.join(pl, 'installed_plugins.json');
const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
reg.plugins = (reg.plugins ?? []).filter((p) => p.id !== id);
reg.plugins.push({
  id, name: 'mdp', marketplace: 'mdp-local', version,
  installPath: cacheDir, installedAt: now, updatedAt: now, scope: 'user',
  source: { source: 'path', type: 'dir', path: pluginSrc.replace(/\\/g, '/') },
  cacheTransactionId: crypto.randomUUID(),
});
fs.writeFileSync(regPath, JSON.stringify(reg, null, 2) + '\n');
console.log(`[install] 注册表 → ${id}`);

// ③ 市场可见性（GUI 市场列表）
const kmPath = path.join(pl, 'known_marketplaces.json');
const km = JSON.parse(fs.readFileSync(kmPath, 'utf8'));
km.marketplaces = (km.marketplaces ?? []).filter((m) => m.id !== 'mdp-local');
km.marketplaces.push({
  id: 'mdp-local', name: 'mdp-local',
  source: { source: 'path', path: path.resolve(path.dirname(pluginSrc)).replace(/\\/g, '/') },
  description: 'Multi-Device-Pool 本地插件市场', addedAt: now, pluginCount: 1, lastUpdated: now,
});
fs.writeFileSync(kmPath, JSON.stringify(km, null, 2) + '\n');
console.log('[install] known_marketplaces → mdp-local');

// ④ 启用
const cfgPath = path.join(os.homedir(), '.zcode', 'cli', 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.enabledPlugins = { ...(cfg.enabledPlugins ?? {}), [id]: true };
cfg.plugins = { ...(cfg.plugins ?? {}), [id]: { source: 'mdp-local' } };
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
console.log('[install] config.enabledPlugins → true（新会话生效）');
