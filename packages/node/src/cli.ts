/** 极简 CLI 参数解析（--key value 形态；node/hub 共用风格） */
export interface CliArgs {
  config?: string;
  home?: string;
  hub?: string;
  name?: string;
  /** 可重复：--ws <name>=<path>（跨机联调免配置文件） */
  ws?: Array<{ name: string; path: string }>;
}

export const resolveArgs = (argv: string[]): CliArgs => {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--config') out.config = argv[++i];
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--hub') out.hub = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--ws') {
      const raw = argv[++i] ?? '';
      const eq = raw.indexOf('=');
      if (eq > 0) {
        out.ws = out.ws ?? [];
        out.ws.push({ name: raw.slice(0, eq), path: raw.slice(eq + 1) });
      }
    }
  }
  return out;
};
