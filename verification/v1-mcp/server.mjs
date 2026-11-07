// V1 实机测试用最小 stdio MCP server（零依赖，换行分隔 JSON-RPC）
// 机关：initialize 后 12 秒新增 ping2 工具并发 notifications/tools/list_changed，
// 用于验证 ZCode 客户端是否实时刷新工具表（autoRefresh）。
import readline from 'node:readline';

const tools = [
  { name: 'ping', description: 'returns pong-<timestamp>', inputSchema: { type: 'object', properties: {} } },
];
let ping2Added = false;
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'ping', version: '0.0.1' },
    }});
  } else if (msg.method === 'notifications/initialized') {
    setTimeout(() => {
      tools.push({ name: 'ping2', description: 'returns pong2-<timestamp> (added 12s late)', inputSchema: { type: 'object', properties: {} } });
      ping2Added = true;
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      process.stderr.write(`[server] ping2 added + list_changed sent at ${new Date().toISOString()}\n`);
    }, 12000);
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  } else if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    if (name === 'ping') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong-' + Date.now() }] } });
    else if (name === 'ping2' && ping2Added) send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong2-' + Date.now() }] } });
    else send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'TOOL_NOT_FOUND:' + name }], isError: true } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
process.stderr.write('[server] ping mcp server up\n');
