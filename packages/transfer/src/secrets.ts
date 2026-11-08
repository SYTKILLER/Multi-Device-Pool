/**
 * 秘密层（红队 P1-10）：路径模式 + 内容启发，命中即硬排除并在 manifest.excluded 列出。
 * 设计立场（01 §5.2）：宁可疑误报由人放行，不可静默漏带。
 */

export const SECRET_PATH_RULES: Array<{ re: RegExp; why: string }> = [
  { re: /(^|\/)\.env(\..+)?$/i, why: '.env 类环境文件' },
  { re: /\.(pem|key|pfx|p12|crt\.)$/i, why: '证书/密钥文件' },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)/i, why: 'SSH 私钥' },
  { re: /(^|\/)\.aws(\/|$)/i, why: 'AWS 凭证目录' },
  { re: /(^|\/)credentials($|\.)/i, why: 'credentials 文件' },
  { re: /(^|\/)\.npmrc$/i, why: '.npmrc 可能含 registry token' },
  { re: /(^|\/)\.ssh(\/|$)/i, why: '.ssh 目录' },
];

export const SECRET_CONTENT_RULES: Array<{ re: RegExp; why: string }> = [
  { re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, why: '私钥块' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, why: 'AWS AccessKey' },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, why: 'sk- 形态 API key' },
  { re: /\bghp_[A-Za-z0-9]{30,}\b/, why: 'GitHub token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, why: 'Slack token' },
];

export const secretPathHit = (relPath: string): string | null => {
  const p = relPath.replace(/\\/g, '/');
  for (const r of SECRET_PATH_RULES) {
    if (r.re.test(p)) return r.why;
  }
  return null;
};

/** 读文件头 scanBytes（默认 8KB）按 latin1 匹配内容启发式；返回原因或 null */
export const secretContentHit = async (absPath: string, scanBytes = 8192): Promise<string | null> => {
  const { readFile } = await import('node:fs/promises');
  let buf: Buffer;
  try {
    const fh = await readFile(absPath);
    buf = fh.subarray(0, scanBytes);
  } catch {
    return null; // 读不动的不猜：按正常文件进 manifest（后续 hash 阶段自然暴露）
  }
  const text = buf.toString('latin1');
  for (const r of SECRET_CONTENT_RULES) {
    if (r.re.test(text)) return r.why;
  }
  return null;
};
