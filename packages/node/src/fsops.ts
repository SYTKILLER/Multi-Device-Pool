/**
 * fs 原语（01 §4.1 静态基线）：read | write | list | glob | grep。
 * 一切路径先过 overlay（realpath 域检查，含符号链接逃逸拒绝）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'node:fs';
import type { Overlay } from './overlay.js';

export interface FsOutcome {
  ok: boolean;
  data?: unknown;     // read→内容文本；list/glob→条目数组；grep→命中数组；write→written 字节数
  error?: string;
}

const deny = (message: string): FsOutcome => ({ ok: false, error: message });

export const fsOp = (overlay: Overlay, op: string, params: { path: string; content?: string; pattern?: string; depth?: number; glob?: string; limit?: number; offset?: number }): FsOutcome => {
  switch (op) {
    case 'read': {
      const r = overlay.resolveFsPath(params.path);
      if (!r.ok) return deny(r.message);
      try {
        const st = fs.statSync(r.abs);
        if (st.isDirectory()) return deny(`read 目标是目录：${params.path}（用 list）`);
        return { ok: true, data: fs.readFileSync(r.abs, 'utf8') };
      } catch (e) { return deny(`read 失败：${(e as Error).message}`); }
    }
    case 'write': {
      const r = overlay.resolveFsPath(params.path);
      if (!r.ok) return deny(r.message);
      const busy = overlay.busyCheck(r.ws.path);
      if (busy) return { ok: false, error: `busy：${busy}` };
      try {
        fs.mkdirSync(path.dirname(r.abs), { recursive: true });
        const content = params.content ?? '';
        fs.writeFileSync(r.abs, content);
        return { ok: true, data: { written: Buffer.byteLength(content, 'utf8'), path: r.abs } };
      } catch (e) { return deny(`write 失败：${(e as Error).message}`); }
    }
    case 'list': {
      const r = overlay.resolveFsPath(params.path);
      if (!r.ok) return deny(r.message);
      try {
        const entries = fs.readdirSync(r.abs, { withFileTypes: true });
        return {
          ok: true,
          data: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other' })),
        };
      } catch (e) { return deny(`list 失败：${(e as Error).message}`); }
    }
    case 'glob': {
      const r = overlay.resolveFsPath(params.path);
      if (!r.ok) return deny(r.message);
      try {
        const found = (globSync(params.glob ?? '**/*', { cwd: r.abs }) as string[]).filter((rel) => {
          try { return fs.statSync(path.join(r.abs, rel)).isFile(); } catch { return false; }
        });
        const limit = params.limit ?? 500;
        return { ok: true, data: { entries: found.slice(0, limit), total: found.length, truncated: found.length > limit } };
      } catch (e) { return deny(`glob 失败：${(e as Error).message}`); }
    }
    case 'grep': {
      const r = overlay.resolveFsPath(params.path);
      if (!r.ok) return deny(r.message);
      try {
        const found = (globSync(params.glob ?? '**/*', { cwd: r.abs }) as string[]).filter((rel) => {
          try { return fs.statSync(path.join(r.abs, rel)).isFile(); } catch { return false; }
        });
        const needle = params.pattern ?? '';
        const hits: Array<{ file: string; line: number; text: string }> = [];
        for (const rel of found) {
          const abs = path.join(r.abs, rel);
          let text: string;
          try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; } // 二进制/权限跳过
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i]!.includes(needle)) {
              hits.push({ file: rel, line: i + 1, text: lines[i]!.slice(0, 200) });
              if (hits.length >= (params.limit ?? 100)) return { ok: true, data: { hits, truncated: true } };
            }
          }
        }
        return { ok: true, data: { hits, truncated: false } };
      } catch (e) { return deny(`grep 失败：${(e as Error).message}`); }
    }
    default:
      return deny(`未知 fs op：${op}（支持 read|write|list|glob|grep）`);
  }
};
