/**
 * node agent 入口：`node dist/index.js --config <cfg.json> --home <dir> [--hub host:port] [--name xxx]`
 * P0 验证形态：同机双进程即可（01 §10 P0 验收）；跨机时 adapter-direct 外层换 TLS。
 */
import { resolveArgs } from './cli.js';
import { loadConfig } from './config.js';
import { loadOrCreateIdentity, defaultHome } from './identity.js';
import { NodeAgent } from './agent.js';

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

const shutdown = (): void => {
  agent.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
