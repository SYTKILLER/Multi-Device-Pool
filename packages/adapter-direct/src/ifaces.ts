import os from 'node:os';

/**
 * 非 internal 的 IPv4 接口枚举（V3 强制约束：多播绝不依赖默认路由，
 * 本机多网卡/虚拟网卡环境下默认接口 addMembership 会 EHOSTUNREACH）。
 */
export const listLanIfaces = (): Array<{ name: string; address: string }> => {
  const out: Array<{ name: string; address: string }> = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
};
