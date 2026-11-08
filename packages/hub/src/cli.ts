/** hub CLI 参数（--key value；attach 子命令） */
export interface CliArgs {
  home?: string;
  port?: number;
  nodePort?: number;
  hubUrl?: string;
  token?: string;
}

export const resolveMode = (argv: string[]): 'daemon' | 'attach' =>
  argv[0] === 'attach' ? 'attach' : 'daemon';

const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));

export const resolveArgs = (argv: string[]): CliArgs => {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--home') out.home = argv[++i];
    else if (a === '--port') out.port = num(argv[++i]);
    else if (a === '--node-port') out.nodePort = num(argv[++i]);
    else if (a === '--hub') out.hubUrl = argv[++i];
    else if (a === '--token') out.token = argv[++i];
  }
  return out;
};
