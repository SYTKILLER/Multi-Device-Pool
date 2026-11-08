// P1-9 打包：复制 attach 产物 → 从 plugin.template.json 渲染 plugin.json（绝对路径，gitignored）→ 校验清单。
// 便携打包（marketplace 路径重写）属 P2；本脚本面向本机安装与 zcode plugins validate。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // apps/zcode-plugin
const repoRoot = path.resolve(pluginDir, '..', '..');
const src = path.join(repoRoot, 'packages', 'hub', 'dist', 'attach.js');
const dist = path.join(pluginDir, 'dist');

if (!fs.existsSync(src)) throw new Error(`缺少 attach 产物：${src}（先 npm run build -w @mdp/hub）`);
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(src, path.join(dist, 'attach.js'));

const tplPath = path.join(pluginDir, '.zcode-plugin', 'plugin.template.json');
const rendered = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
for (const srv of Object.values(rendered.mcpServers)) {
  srv.args = srv.args.map((a) => a.replace('__MDP_PLUGIN_DIST__', dist.replace(/\\/g, '/')));
}
const outPath = path.join(pluginDir, '.zcode-plugin', 'plugin.json');
fs.writeFileSync(outPath, JSON.stringify(rendered, null, 2) + '\n');

console.log(`[build] attach.js → dist/`);
console.log(`[build] plugin.json 渲染：${rendered.mcpServers.mdp.args[0]}`);
console.log(`[build] 冒烟：echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | node dist/attach-plugin.mjs`);
