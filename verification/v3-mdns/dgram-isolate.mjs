// V3 隔离测试：裸 dgram 多播回环（224.0.0.251:5353）
// A 绑定 5353 + 加组；B 向组发 10 字节。A 收到 → OS 多播回环可用（问题在用法/时序）；收不到 → 防火墙/系统拦入站多播。
import dgram from 'node:dgram';

const a = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let received = false;
a.on('message', (m, r) => {
  received = true;
  console.log(`A 收到 ${m.length} 字节，来自 ${r.address}:${r.port}`);
});
a.on('error', (e) => { console.log('A error:', e.message); process.exit(1); });
a.bind(5353, () => {
  try { a.addMembership('224.0.0.251'); console.log('A 已绑定 5353 并加入多播组'); }
  catch (e) { console.log('addMembership 失败:', e.message); }
  const b = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  b.bind(() => {
    try { b.setMulticastLoopback(true); } catch {}
    const msg = Buffer.from('mdp-spike-probe');
    let n = 0;
    const t = setInterval(() => {
      b.send(msg, 5353, '224.0.0.251', () => {
        if (++n >= 5) {
          clearInterval(t);
          setTimeout(() => {
            console.log(received ? 'PASS  OS 多播回环可用（入站多播未被防火墙拦）' : 'FAIL  5 次发送后 A 仍收不到 → 入站多播被拦（需防火墙放行 node.exe UDP 5353）');
            a.close(); b.close();
            process.exit(received ? 0 : 1);
          }, 800);
        }
      });
    }, 300);
  });
});
