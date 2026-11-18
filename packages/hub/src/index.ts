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
  // token 复用（2026-11-19 常驻化）：daemon 支持 --token 显式传入；缺省才新签。
  // 重启不轮换凭证——已挂载的插件 attach 桥与跨机 token 交接不受 hub 重启影响
  const token = args.token ?? createHubToken();
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
  // 端口占用等启动失败：清晰报错退出（守护脚本靠非零退出感知），不裸崩 null 解引用
  httpServer.on('error', (e: NodeJS.ErrnoException) => {
    console.error(`[hub] 启动失败：${e.message}（端口 ${args.port ?? 7800} 被占用？先停旧 hub）`);
    process.exit(1);
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
