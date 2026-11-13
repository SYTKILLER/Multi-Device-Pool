// P1-9 打包：复制 attach 产物 → 从 plugin.template.json 渲染 plugin.json（绝对路径，gitignored）→ 校验清单。
// 便携打包（marketplace 路径重写）属 P2；本脚本面向本机安装与 zcode plugins validate。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // apps/zcode-plugin/mdp（插件本体根）
const repoRoot = path.resolve(pluginDir, '..', '..', '..');
const hubDist = path.join(repoRoot, 'packages', 'hub', 'dist');
const dist = path.join(pluginDir, 'dist');

// 互审修正（A 机 2026-11-14）：插件 MCP 入口 = hub CLI 入口（`node index.js attach`）。
// 原方案复制 attach.js——它只导出 runAttach 不自执行，桌面端 `node attach-plugin.mjs` 会静默挂死
// （stdio 冒烟零输出）。index.js 的 attach 分支自带默认值：hub http://127.0.0.1:7800、
// token 回读 <home>/hub-info.json，语义与 plugin.json 不带参数一致。整目录复制保证 ESM 相对导入完整。
if (!fs.existsSync(path.join(hubDist, 'index.js'))) throw new Error(`缺少 hub 产物：${hubDist}（先 npm run build -w @mdp/hub）`);
fs.mkdirSync(dist, { recursive: true });
fs.cpSync(hubDist, dist, { recursive: true, filter: (s) => !s.endsWith('.d.ts') && !s.endsWith('.tsbuildinfo') && !s.includes('node_modules') });

const tplPath = path.join(pluginDir, '.zcode-plugin', 'plugin.template.json');
const rendered = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
for (const srv of Object.values(rendered.mcpServers)) {
  srv.args = srv.args.map((a) => a.replace('__MDP_PLUGIN_DIST__', dist.replace(/\\/g, '/')));
}
const outPath = path.join(pluginDir, '.zcode-plugin', 'plugin.json');
fs.writeFileSync(outPath, JSON.stringify(rendered, null, 2) + '\n');

console.log(`[build] hub dist → plugin dist/（MCP 入口 dist/index.js attach）`);
console.log(`[build] plugin.json 渲染：node ${rendered.mcpServers.mdp.args.join(' ')}`);
console.log(`[build] 冒烟：echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | node dist/index.js attach`);
