/**
 * gitignore-lite（P1-10 范围声明）：只支持无取反（`!`）的子集——精确名、`*.ext`、`dir/`。
 * 语义：体积层（构建产物/依赖目录），不承担安全职责（那是秘密层的事，见 secrets.ts）。
 * 已知局限（记录在案）：无 `!` 取反、无 `**`、无 `[^]` 字符类、`/` 前缀锚定按任意层级匹配放宽。
 * 若 P2 需要完整语义，换 `ignore` npm 包并在此封装。
 */
export interface IgnoreRule { pattern: string; isDir: boolean; isGlob: boolean; raw: string }

export const parseIgnoreLines = (text: string): IgnoreRule[] => {
  const out: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('!')) continue; // 子集：不支持取反（记录于文档头）
    let pattern = line;
    const isDir = pattern.endsWith('/');
    if (isDir) pattern = pattern.slice(0, -1);
    pattern = pattern.replace(/^\.\//, '');
    if (pattern === '') continue;
    out.push({ pattern, isDir, isGlob: pattern.includes('*'), raw: line });
  }
  return out;
};

const baseName = (p: string): string => p.split('/').pop() ?? p;
const globToRegExp = (glob: string): RegExp =>
  new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');

export const matcher = (rules: IgnoreRule[]): { matches: (relPath: string, isDir: boolean) => boolean } => {
  const compiled = rules.map((r) => ({
    ...r,
    re: r.isGlob ? globToRegExp(r.pattern) : undefined,
  }));
  return {
    matches: (relPath, isDir) => {
      const rel = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
      const base = baseName(rel);
      const segments = rel.split('/');
      for (const r of compiled) {
        if (r.isDir && !isDir) {
          // dir 模式也匹配"路径位于该目录下"（任一段等于 pattern）
          if (segments.slice(0, -1).includes(r.pattern)) return true;
          continue;
        }
        if (r.re) {
          if (r.re.test(base) || r.re.test(rel)) return true;
        } else if (base === r.pattern || segments.includes(r.pattern)) {
          return true;
        }
      }
      return false;
    },
  };
};
