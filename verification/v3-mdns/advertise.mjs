// V3 跨机测试 · 广播端：每 2s 向多播组发 announce（显式绑接口，零依赖）
// 用法：node advertise.mjs [接口IP]   （缺省=枚举第一个非内部 IPv4）
import dgram from 'node:dgram';
import os from 'node:os';

const GROUP = '239.255.77.68', PORT = 53550;
const ifaces = Object.entries(os.networkInterfaces()).flatMap(([n, as]) => (as ?? []).filter(a => a.family === 'IPv4' && !a.internal).map(a => ({ name: n, address: a.address })));
const target = process.argv[2] ?? ifaces[0]?.address;
if (!target) { console.error('FAIL 无可用 IPv4 接口'); process.exit(1); }
console.log(`广播接口: ${ifaces.find(i => i.address === target)?.name ?? '?'}=${target}，组 ${GROUP}:${PORT}，Ctrl+C 停止`);

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sock.bind(PORT, () => {
  sock.addMembership(GROUP, target);
  sock.setMulticastTTL(2);
  const announce = Buffer.from(JSON.stringify({
    service: 'mdp-spike', proto: 'mdp/1',
    node_id: 'advertise-' + process.pid,
    host: os.hostname(), lan_ip: target, mdp_port: 7900, ts: Date.now(),
  }));
  setInterval(() => sock.send(announce, PORT, GROUP, (e) => { if (e) console.error('send err:', e.message); }), 2000);
  console.log('announcing...', JSON.parse(announce.toString()).node_id);
});
sock.on('error', (e) => console.error('error:', e.message));
