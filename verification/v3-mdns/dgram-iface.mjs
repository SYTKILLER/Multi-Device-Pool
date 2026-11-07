// V3 隔离测试 2：显式指定多播接口（枚举本机 IPv4 非内部接口逐一尝试）
import dgram from 'node:dgram';
import os from 'node:os';

const ifaces = [];
for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
  for (const a of addrs ?? []) {
    if (a.family === 'IPv4' && !a.internal) ifaces.push({ name, address: a.address });
  }
}
console.log('候选接口:', ifaces.map(i => `${i.name}=${i.address}`).join(', ') || '(无)');

const target = process.argv[2] ?? ifaces[0]?.address;
if (!target) { console.log('FAIL 无可用 IPv4 接口'); process.exit(1); }
console.log(`使用接口: ${target}`);

const a = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let received = false;
a.on('message', (m, r) => { received = true; console.log(`A 收到 ${m.length} 字节，来自 ${r.address}:${r.port}`); });
a.on('error', (e) => { console.log('A error:', e.message); });
a.bind(5353, () => {
  try { a.addMembership('224.0.0.251', target); console.log(`A 加入多播组（接口 ${target}）成功`); }
  catch (e) { console.log(`addMembership(${target}) 失败:`, e.message); process.exit(1); }
  const b = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  b.bind(() => {
    try { b.setMulticastLoopback(true); b.setMulticastInterface(target); } catch (e) { console.log('b 设置失败:', e.message); }
    const msg = Buffer.from('mdp-spike-probe-2');
    let n = 0;
    const t = setInterval(() => {
      b.send(msg, 5353, '224.0.0.251', () => {
        if (++n >= 5) {
          clearInterval(t);
          setTimeout(() => {
            console.log(received ? `PASS  显式接口 ${target} 下多播回环可用` : 'FAIL  仍收不到 → 防火墙入站拦截（放行 node.exe UDP 5353 入站）');
            a.close(); b.close();
            process.exit(received ? 0 : 1);
          }, 800);
        }
      });
    }, 300);
  });
});
