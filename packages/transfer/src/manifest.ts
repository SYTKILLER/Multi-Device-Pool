/**
 * manifest walk（01 §5.2 / P1-10）：目录 → 传输清单。
 * 双层过滤：ignore 层（体积）→ 秘密层（安全，硬排除）→ 符号链接永不跟随。
 * 决定性输出：files/refs/excluded 均按 path 排序；sha256 流式计算。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseIgnoreLines, matcher, type IgnoreRule } from './ignore.js';
import { secretPathHit, secretContentHit } from './secrets.js';

export interface ManifestFile { path: string; size: number; sha256: string; mode: number }
export interface ManifestRef { path: string; target: string; kind: 'symlink'; insideRoot: boolean }
export interface ManifestExcluded { path: string; reason: 'ignore' | 'secret' | 'secret-content' | 'symlink-out' | 'lockfile'; detail?: string }

export interface TransferManifest {
  root: string;
  generatedAt: string;
  files: ManifestFile[];
  refs: ManifestRef[];
  excluded: ManifestExcluded[];
  totalBytes: number;
}

/** 体积层默认项（目录按段剪枝；文件按名匹配）。注意：不含 `*.lock`——Cargo.lock/flake.lock 等是合法项目文件；活锁文件按 01 §5.2 由 LOCKFILE_RE 单独成桶（.git/*.lock 随 .git 剪枝） */
const DEFAULT_DIR_IGNORES = ['node_modules', '.git', 'dist', 'build', 'target', '__pycache__', '.venv', 'venv', '.mdp-staging'];
const DEFAULT_FILE_IGNORES: string[] = [];
/** 活锁文件（01 §5.2：.git/*.lock 已随 .git 剪枝；此处为编辑器交换文件）——先于体积层判定，单独成桶 */
const LOCKFILE_RE = /\.(swp|swo|swpx)$/i;
const GITIGNORE = '.gitignore';

const sha256File = async (abs: string): Promise<string> => {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(abs, { highWaterMark: 64 * 1024 });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
};

export const buildManifest = async (root: string, opts: { extraIgnore?: string[] } = {}): Promise<TransferManifest> => {
  const rootAbs = path.resolve(root);
  const manifest: TransferManifest = {
    root: rootAbs, generatedAt: new Date().toISOString(), files: [], refs: [], excluded: [], totalBytes: 0,
  };
  // 每层目录一个 ignore 匹配器栈（本目录 .gitignore + extraIgnore 只作用于其子树，向下继承）
  const walk = async (dir: string, rel: string, rules: IgnoreRule[]): Promise<void> => {
    const gi = path.join(dir, GITIGNORE);
    const layers = rules;
    let own: IgnoreRule[] = [];
    try {
      const text = await fsp.readFile(gi, 'utf8');
      own = parseIgnoreLines(text);
    } catch { /* 无 .gitignore */ }
    const local = matcher([...layers, ...own]);
    const relDirBase = rel === '' ? '' : rel + '/';

    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { manifest.excluded.push({ path: relDirBase || './', reason: 'ignore', detail: '目录不可读' }); return; }

    for (const entry of entries) {
      const childRel = relDirBase + entry.name;
      if (entry.isSymbolicLink()) {
        // 符号链接：永不跟随（红队 P1-10 逃逸面）。指向根内 → refs；指向根外 → excluded 由人复核。
        let target = '';
        try { target = await fsp.readlink(path.join(dir, entry.name)); } catch { target = '<unreadable>'; }
        const resolved = path.resolve(dir, target);
        const inside = resolved.startsWith(rootAbs + path.sep) || resolved === rootAbs;
        if (inside) {
          manifest.refs.push({ path: childRel, target, kind: 'symlink', insideRoot: true });
        } else {
          manifest.refs.push({ path: childRel, target, kind: 'symlink', insideRoot: false });
          manifest.excluded.push({ path: childRel, reason: 'symlink-out', detail: `→ ${target}` });
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (DEFAULT_DIR_IGNORES.includes(entry.name)) {
          manifest.excluded.push({ path: childRel + '/', reason: 'ignore', detail: '默认体积项' });
          continue;
        }
        if (local.matches(childRel, true)) {
          manifest.excluded.push({ path: childRel + '/', reason: 'ignore', detail: 'gitignore-lite' });
          continue;
        }
        await walk(path.join(dir, entry.name), childRel, own.length > 0 ? [...layers, ...own] : layers);
        continue;
      }
      if (entry.isFile()) {
        if (LOCKFILE_RE.test(entry.name)) {
          manifest.excluded.push({ path: childRel, reason: 'lockfile', detail: '编辑器活锁文件' });
          continue;
        }
        const volHit = DEFAULT_FILE_IGNORES.some((p) => matcher(parseIgnoreLines(p)).matches(childRel, false))
          || local.matches(childRel, false)
          || (opts.extraIgnore ?? []).some((p) => matcher(parseIgnoreLines(p)).matches(childRel, false));
        if (volHit) {
          manifest.excluded.push({ path: childRel, reason: 'ignore', detail: '体积层' });
          continue;
        }
        const secretWhy = secretPathHit(childRel);
        if (secretWhy) {
          manifest.excluded.push({ path: childRel, reason: 'secret', detail: secretWhy });
          continue;
        }
        const abs = path.join(dir, entry.name);
        const stat = await fsp.stat(abs);
        const contentWhy = await secretContentHit(abs);
        if (contentWhy) {
          manifest.excluded.push({ path: childRel, reason: 'secret-content', detail: contentWhy });
          continue;
        }
        const sha = await sha256File(abs);
        manifest.files.push({ path: childRel, size: stat.size, sha256: sha, mode: stat.mode & 0o777 });
        manifest.totalBytes += stat.size;
        continue;
      }
      // 其他类型（fifo/socket 等）：不进清单，不报错
    }
  };

  await walk(rootAbs, '', []);
  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  manifest.files.sort(byPath);
  manifest.refs.sort(byPath);
  manifest.excluded.sort(byPath);
  return manifest;
};
