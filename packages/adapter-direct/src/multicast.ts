/**
 * 同介质组播 announce（优化路径，V3 定论：跨介质组播被 AP 过滤，仅同介质可用）。
 * 实现说明：这是**自定义 announce 协议**（JSON over UDP 组播，239.255.77.68:53550），
 * 不是 DNS-SD/mDNS——两端皆为池软件、无需 OS 级互操作；显式接口绑定是我们的强制项，
 * 自定义协议下实现最直接。规格修订已在看板「决策请求」区登记。
 * 发送：逐接口 setMulticastInterface + loopback（同机测试可达）；接收：全接口加组。
 */
import dgram from 'node:dgram';
import { encodeAnnounce, parseAnnounce, type AnnouncePayload } from './protocol.js';
import { ANNOUNCE_GROUP, ANNOUNCE_PORT } from '@mdp/contract';
import { listLanIfaces } from './ifaces.js';

export { ANNOUNCE_GROUP, ANNOUNCE_PORT } from '@mdp/contract';

export interface MulticastAnnouncerOpts {
  payload: AnnouncePayload;      // kind 会被强制为 'announce'
  intervalMs?: number;           // 默认 2000
  ifaces?: string[];             // 缺省=全部非 internal IPv4
  loopback?: boolean;            // 默认 true（同机 browser 可见，测试与单机联调依赖）
}
export class MulticastAnnouncer {
  private sock?: dgram.Socket;
  private timer?: NodeJS.Timeout;
  constructor(private readonly opts: MulticastAnnouncerOpts) {}
  start(): void {
    if (this.sock) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    const ifaces = this.opts.ifaces ?? listLanIfaces().map(i => i.address);
    sock.bind(() => {
      try { sock.setMulticastLoopback(this.opts.loopback ?? true); } catch { /* 平台差异容忍 */ }
      sock.setMulticastTTL(2);
      const wire = encodeAnnounce({ ...this.opts.payload, kind: 'announce' });
      const sendAll = () => {
        for (const iface of ifaces) {
          try { sock.setMulticastInterface(iface); sock.send(wire, ANNOUNCE_PORT, ANNOUNCE_GROUP); }
          catch { /* 接口可能已失效（Wi-Fi 切换），跳过该口 */ }
        }
      };
      sendAll();
      this.timer = setInterval(sendAll, this.opts.intervalMs ?? 2000);
    });
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try { this.sock?.close(); } catch { /* 已关闭 */ }
    this.sock = undefined;
  }
}

export interface DiscoveredEntry {
  payload: AnnouncePayload;
  lastSeen: string;
  remote: Remote;
}
type Remote = { address: string; port: number };

export interface MulticastBrowserOpts {
  ttlMs?: number;                // 条目过期（视为下线），默认 8000 = 4×interval
  ifaces?: string[];
  /** isNew=true 首见；false 刷新；onDown 到期下线 */
  onEntry: (payload: AnnouncePayload, remote: Remote, isNew: boolean) => void;
  onDown?: (payload: AnnouncePayload) => void;
  /** 过滤（如 role==='hub'）；被过滤的报文不计入 seen */
  filter?: (p: AnnouncePayload) => boolean;
}
export class MulticastBrowser {
  private sock?: dgram.Socket;
  private sweeper?: NodeJS.Timeout;
  private readonly seen = new Map<string, { payload: AnnouncePayload; lastSeen: number; remote: Remote }>();
  constructor(private readonly opts: MulticastBrowserOpts) {}
  /** 返回成功加组的接口数；**调用方应检查 joined===0** 的场景（无 LAN 接口/全部失效）并自行降级（互审 nit ①） */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.sock = sock;
      sock.on('error', reject);
      sock.on('message', (buf, rinfo) => {
        const p = parseAnnounce(buf);
        if (!p || p.kind !== 'announce') return;
        if (this.opts.filter && !this.opts.filter(p)) return;
        const key = `${p.role}:${p.id}`;
        const prev = this.seen.get(key);
        this.seen.set(key, { payload: p, lastSeen: Date.now(), remote: { address: rinfo.address, port: rinfo.port } });
        this.opts.onEntry(p, { address: rinfo.address, port: rinfo.port }, !prev);
      });
      sock.bind(ANNOUNCE_PORT, () => {
        let joined = 0;
        const ifaces = this.opts.ifaces ?? listLanIfaces().map(i => i.address);
        for (const iface of ifaces) {
          try { sock.addMembership(ANNOUNCE_GROUP, iface); joined += 1; } catch { /* 接口失效容忍 */ }
        }
        const ttl = this.opts.ttlMs ?? 8000;
        this.sweeper = setInterval(() => {
          const now = Date.now();
          for (const [key, e] of this.seen) {
            if (now - e.lastSeen > ttl) {
              this.seen.delete(key);
              this.opts.onDown?.(e.payload);
            }
          }
        }, Math.min(2000, Math.max(100, Math.round(ttl / 2))));
        resolve(joined);
      });
    });
  }
  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    try { this.sock?.close(); } catch { /* 已关闭 */ }
    this.sock = undefined;
    this.seen.clear();
  }
}
