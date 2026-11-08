/**
 * hub 入口：
 *   `node dist/index.js --home <dir> [--port 7800] [--node-port 7900]`   启动 daemon
 *   `node dist/index.js attach --hub <url> --token <t>`                  stdio 桥
 * 启动即写 <home>/hub-info.json（端口/令牌/节点端口），等价 GUI 首访粘贴的令牌来源（01 §7）。
 */
import fs from 'node:fs';
import { resolveArgs, resolveMode } from './cli.js';
import { loadHubDb, saveHubDb, createHubToken, writeHubInfo, defaultHome } from './state.js';
import { Hub } from './hub.js';
import { startMcpHttp } from './mcp.js';
import { runAttach } from './attach.js';

const argv = process.argv.slice(2);
const mode = resolveMode(argv);
const args = resolveArgs(argv.filter((a) => a !== 'attach'));

if (mode === 'attach') {
  let token = args.token;
  if (!token) {
    try {
      const info = JSON.parse(fs.readFileSync(`${defaultHome()}/hub-info.json`, 'utf8')) as { token?: string };
      token = info.token ?? '';
    } catch {
      token = '';
    }
  }
  runAttach({ hubUrl: args.hubUrl ?? 'http://127.0.0.1:7800', token });
} else {
  const home = args.home ?? defaultHome();
  fs.mkdirSync(home, { recursive: true });
  const db = loadHubDb(home);
  const token = createHubToken();
  const hub = new Hub({
    home,
    db,
    nodePort: args.nodePort ?? 7900,
    log: (l) => console.log(`[hub] ${l}`),
  });
  const httpServer = startMcpHttp(hub, {
    port: args.port ?? 7800,
    token,
    log: () => { /* 每调用打日志太吵，需要时再开 */ },
  });
  const addr = httpServer.address() as { port: number };
  const infoFile = writeHubInfo(home, {
    token,
    mcp_port: addr.port,
    node_port: hub.nodePort,
    pid: process.pid,
    started_at: new Date().toISOString(),
  });
  console.log(`[hub] MCP :${addr.port}  nodes :${hub.nodePort}  token→${infoFile}`);
  saveHubDb(home, db);

  const shutdown = (): void => {
    hub.close();
    httpServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
