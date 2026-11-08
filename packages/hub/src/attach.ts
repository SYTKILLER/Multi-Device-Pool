/**
 * mdp attach：stdio ↔ hub /mcp 的桥（01 §1.3 备选接入面；1.3 已证实 ZCode 支持 http 直挂，
 * 桥保留给：不支持带鉴权头 http 挂载的 harness、或用户偏好 stdio 配置行的场景）。
 * 用法：`mdp attach --hub http://127.0.0.1:7800 --token <token>`，作为 harness 的 MCP stdio 命令。
 */
import readline from 'node:readline';

export interface AttachOptions {
  hubUrl: string;   // 如 http://127.0.0.1:7800
  token: string;
}

export const runAttach = (opts: AttachOptions): void => {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    void (async () => {
      try {
        const res = await fetch(`${opts.hubUrl}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` },
          body: line,
        });
        if (res.status === 202) return; // notification：无应答帧
        const body = await res.text();
        if (body.trim()) process.stdout.write(body.replace(/\n/g, ' ') + '\n');
      } catch (e) {
        // 尽力回一帧 JSON-RPC error，避免 harness 端挂死
        let msg: Record<string, unknown> = {};
        try { msg = JSON.parse(line) as Record<string, unknown>; } catch { /* 无法回帧 */ }
        if (msg['id'] !== undefined) {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg['id'], error: { code: -32000, message: `hub 不可达：${String((e as Error).message ?? e)}` } }) + '\n');
        }
      }
    })();
  });
  process.stderr.write(`[mdp-attach] → ${opts.hubUrl}\n`);
};
