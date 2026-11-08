/**
 * hub MCP server（01 §1.1 /mcp）：Streamable HTTP 形态（POST application/json 单帧应答；
 * P0 静态基线无需 SSE 推送，list_changed 推送 P1 随 per-node 前缀组引入）。
 * 认证：loopback token（Authorization: Bearer；01 §7，管理面/工具面共用令牌来源分离在 P1）。
 * REST：/jobs/:id/approve|deny 代理 GUI 审批卡（P0 测试面），同样要求令牌（红队 P0-3）。
 */
import http from 'node:http';
import type { ResultEnvelope } from '@mdp/contract';
import { TOOL_DEFS } from './mcp-tools.js';
import { extractCmdPrefix } from './hub.js';
import type { Hub } from './hub.js';

export interface McpHttpOptions {
  port: number;
  token: string;
  log: (line: string) => void;
}

const json = (res: http.ServerResponse, code: number, body: unknown): void => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
};

const envelopeText = (env: ResultEnvelope): string => JSON.stringify(env, null, 2);

export const startMcpHttp = (hub: Hub, opts: McpHttpOptions): http.Server => {
  const server = http.createServer(async (req, res) => {
    const auth = req.headers['authorization'] ?? '';
    const tokenOk = auth === `Bearer ${opts.token}`;

    if (req.url === '/healthz') return json(res, 200, { ok: true, uptime_s: Math.round(process.uptime()) });

    if (!tokenOk) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return json(res, 401, { error: '需要管理令牌（Authorization: Bearer <token>，hub-info.json）' });
    }

    if (req.url === '/mcp' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch {
        return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const reply = await hub.handleJsonRpc(msg);
      if (reply === undefined) return json(res, 202, {}); // notification
      return json(res, 200, reply);
    }

    // 审批 REST（GUI 代理；审批人=持令牌者，01 §6）。body {remember?:boolean, prefix?:string} → P1-2 学习式白名单
    const m = /^\/jobs\/([\w-]+)\/(approve|deny)$/.exec(req.url ?? '');
    if (m && req.method === 'POST') {
      const [, jobId, action] = m;
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: { remember?: boolean; prefix?: string } = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as typeof body; } catch { /* 空/坏 body 视作不带参数 */ }
      let ok: boolean;
      if (action === 'approve') {
        const cmd = hub.jobs.jobs.get(jobId!)?.cmd ?? '';
        const prefix = body.remember ? (body.prefix ?? extractCmdPrefix(cmd)) : undefined;
        ok = hub.approveJob(jobId!, opts.token, prefix ? { prefix } : undefined);
      } else {
        ok = hub.jobs.deny(jobId!, opts.token);
      }
      return json(res, ok ? 200 : 409, { ok, job_id: jobId, state: hub.jobs.jobs.get(jobId!)?.state });
    }

    if (req.url === '/jobs' && req.method === 'GET') {
      const list = [...hub.jobs.jobs.values()].map((j) => ({
        job_id: j.job_id, node_id: j.node_id, kind: j.kind, state: j.state, cmd: j.cmd,
        created_at: j.created_at, ttl_ms: j.ttl_ms,
      }));
      return json(res, 200, { jobs: list });
    }

    if (req.url === '/nodes' && req.method === 'GET') {
      return json(res, 200, hub.nodesSnapshot());
    }

    // overlay 编辑面（P1-1；GUI 骨架落地前的 GUI 代理，令牌必需 01 §7）
    const ov = /^\/nodes\/([\w-]+)\/overlay$/.exec(req.url ?? '');
    if (ov) {
      const nodeId = ov[1]!;
      if (req.method === 'GET') {
        const overlay = hub.getOverlay(nodeId);
        return overlay ? json(res, 200, { node_id: nodeId, overlay }) : json(res, 404, { error: `池内无节点 ${nodeId}` });
      }
      if (req.method === 'PATCH') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        let patch: Record<string, unknown>;
        try { patch = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch {
          return json(res, 400, { error: 'PATCH body 不是合法 JSON' });
        }
        const overlay = hub.updateOverlay(nodeId, patch as never);
        return overlay ? json(res, 200, { ok: true, node_id: nodeId, overlay }) : json(res, 404, { error: `池内无节点 ${nodeId}` });
      }
    }

    json(res, 404, { error: `未知端点 ${req.method} ${req.url}` });
  });
  server.listen(opts.port);
  return server;
};
