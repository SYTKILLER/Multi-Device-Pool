// V3 跨机测试 · 发现端：加入多播组，打印收到的 announce（所有非内部接口逐一加组）
// 用法：node browse.mjs   （与 advertise.mjs 在**不同设备**上运行）
import dgram from 'node:dgram';
import os from 'node:os';

const GROUP = '239.255.77.68', PORT = 53550;
const ifaces = Object.entries(os.networkInterfaces()).flatMap(([n, as]) => (as ?? []).filter(a => a.family === 'IPv4' && !a.internal).map(a => ({ name: n, address: a.address })));
console.log(`本机接口: ${ifaces.map(i => `${i.name}=${i.address}`).join(', ')}`);
console.log(`监听 ${GROUP}:${PORT}，等待 announce（Ctrl+C 停止）...\n`);

const seen = new Map();
const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sock.on('message', (buf, rinfo) => {
  try {
    const a = JSON.parse(buf.toString('utf8'));
    if (a.service !== 'mdp-spike') return;
    const key = `${a.node_id}@${rinfo.address}`;
    const isNew = !seen.has(key);
    seen.set(key, Date.now());
    if (isNew) {
      console.log(`DISCOVERED  node=${a.node_id} host=${a.host} lan=${a.lan_ip} mdp_port=${a.mdp_port} via ${rinfo.address}:${rinfo.port}`);
      console.log(`            （跨机到达：来源 ${rinfo.address} ${rinfo.address === a.lan_ip ? '= 自报 LAN IP ✓' : '≠ 自报 IP，注意 NAT/多网卡'}）`);
    }
  } catch { /* 非本服务流量 */ }
});
sock.bind(PORT, () => {
  let joined = 0;
  for (const i of ifaces) {
    try { sock.addMembership(GROUP, i.address); joined++; console.log(`  加组成功（接口 ${i.name}=${i.address}）`); }
    catch (e) { console.log(`  加组失败（接口 ${i.name}=${i.address}）: ${e.message}`); }
  }
  if (ifaces.length === 0) { try { sock.addMembership(GROUP); console.log('  加组成功（默认接口）'); } catch (e) { console.log('  默认接口加组失败:', e.message); } }
  console.log(`  共 ${joined}/${ifaces.length || 1} 个接口入组\n`);
});
sock.on('error', (e) => console.error('error:', e.message));
