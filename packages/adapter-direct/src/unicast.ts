/**
 * 单播直投发现（主路径，V3 定论：跨介质组播不可依赖）。
 * hub 侧：UnicastAnnounceServer 监听 UDP 发现端口（与 TCP 节点端点同号不同协议）；
 * node 侧：announceUnicast 直发 + 等 reply，带重试。
 * 单播走系统路由表，无需多播组员关系；跨网段也可用。
 */
import dgram from 'node:dgram';
import { encodeAnnounce, parseAnnounce, type AnnouncePayload } from './protocol.js';

export interface Remote { address: string; port: number }

export class UnicastAnnounceServer {
  private socket?: dgram.Socket;
  /** handler 里调用 reply 即向来源地址单播回 announce_reply */
  constructor(
    private readonly opts: {
      port: number;
      /** 返回 false 可忽略该 announce（如来源不合法） */
      onAnnounce: (payload: AnnouncePayload, remote: Remote, reply: (resp: AnnouncePayload) => void) => void;
    },
  ) {}

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      this.socket = sock;
      sock.on('error', (e) => reject(e));
      sock.on('message', (buf, rinfo) => {
        const payload = parseAnnounce(buf);
        if (!payload || payload.kind !== 'announce') return;
        this.opts.onAnnounce(payload, { address: rinfo.address, port: rinfo.port }, (resp) => {
          try { sock.send(encodeAnnounce(resp), rinfo.port, rinfo.address); } catch { /* 对端已消失 */ }
        });
      });
      sock.bind(this.opts.port, () => resolve(sock.address().port));
    });
  }

  stop(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}

export interface AnnounceUnicastOpts {
  host: string;
  port: number;
  /** 发出的 announce（kind 会被强制为 'announce'） */
  payload: AnnouncePayload;
  retries?: number;      // 总尝试次数（含首次），默认 3
  gapMs?: number;        // 重试间隔，默认 500
  timeoutMs?: number;    // 单次等待 reply 超时，默认 800
  /** 校验 reply（如 id/role 匹配）；不匹配视为本次失败继续重试 */
  filter?: (reply: AnnouncePayload) => boolean;
}

/** 返回首个通过 filter 的 reply；耗尽返回 null（未发现，调用方回退手输地址） */
export const announceUnicast = (opts: AnnounceUnicastOpts): Promise<AnnouncePayload | null> =>
  new Promise((resolve) => {
    const retries = opts.retries ?? 3;
    const gapMs = opts.gapMs ?? 500;
    const timeoutMs = opts.timeoutMs ?? 800;
    const wire = { ...opts.payload, kind: 'announce' as const };
    let attempt = 0;
    let pending = false;
    const sock = dgram.createSocket({ type: 'udp4' });
    let timer: NodeJS.Timeout | undefined;

    const finish = (r: AnnouncePayload | null) => {
      if (pending) return;
      pending = true;
      if (timer) clearTimeout(timer);
      try { sock.close(); } catch { /* 已关闭 */ }
      resolve(r);
    };

    sock.on('message', (buf, rinfo) => {
      const p = parseAnnounce(buf);
      if (!p || p.kind !== 'announce_reply') return;
      if (rinfo.address !== opts.host && rinfo.address !== '127.0.0.1') return; // 只信目标主机的 reply
      if (opts.filter && !opts.filter(p)) return;
      finish(p);
    });
    sock.on('error', () => finish(null));

    sock.bind(() => {
      const attemptOnce = () => {
        attempt += 1;
        sock.send(encodeAnnounce(wire), opts.port, opts.host, () => {
          timer = setTimeout(() => {
            if (attempt >= retries) finish(null);
            else setTimeout(attemptOnce, gapMs);
          }, timeoutMs);
        });
      };
      attemptOnce();
    });
  });
