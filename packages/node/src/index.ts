/**
 * node agent 入口：`node dist/index.js --config <cfg.json> --home <dir> [--hub host:port] [--name xxx]`
 * P0 验证形态：同机双进程即可（01 §10 P0 验收）；跨机时 adapter-direct 外层换 TLS。
 */
import { resolveArgs } from './cli.js';
import { loadConfig } from './config.js';
import { loadOrCreateIdentity, defaultHome } from './identity.js';
import { NodeAgent } from './agent.js';
import fs from 'node:fs';
import path from 'node:path';

const args = resolveArgs(process.argv.slice(2));
const home = args.home ?? defaultHome();
const identity = loadOrCreateIdentity(home);
const config = loadConfig(args.config, {
  hub: args.hub,
  display_name: args.name,
  ...(args.ws ? { workspaces: args.ws } : {}),
});
const agent = new NodeAgent({
  home,
  config,
  identity,
  onLog: (l) => console.log(`[node:${config.display_name}] ${l}`),
});
agent.start();

// P1-6：自持 PID 文件——`mdp node stop` 按此定位进程树（verification-p0 §6：npm 包装链有孤儿，
// 必须按树杀；本文件是"谁是节点进程"的权威答案）
const pidFile = path.join(home, 'node.pid');
fs.writeFileSync(pidFile, String(process.pid));

const shutdown = (): void => {
  agent.stop();
  try { fs.rmSync(pidFile, { force: true }); } catch { /* 已删 */ }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
