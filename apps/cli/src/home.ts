/** --home 参数 / MDP_HOME / 默认 ~/.mdp 的统一解析（index.ts 与 file.ts 共用） */
import os from 'node:os';
import path from 'node:path';

export const homeOf = (): string => {
  const i = process.argv.indexOf('--home');
  return i >= 0 ? (process.argv[i + 1] ?? os.homedir() + '/.mdp') : process.env['MDP_HOME'] ?? path.join(os.homedir(), '.mdp');
};
