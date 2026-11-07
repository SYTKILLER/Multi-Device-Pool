// V3: mDNS 广播+发现 spike（同一主机先广播后浏览；跨机发现需第二台机器，列入用户协助项）
import { Bonjour } from 'bonjour-service';

const bonjour = new Bonjour({ loopback: true });

// 1) 模拟 node agent：广播 _mdp._tcp
const service = bonjour.publish({
  name: 'mdp-node-spike',
  type: 'mdp',
  port: 7900,
  txt: { epoch: '1', node_id: 'spike-node', proto: 'mdp/1' },
});

const found = [];
const browser = bonjour.find({ type: 'mdp' }, (svc) => {
  found.push(svc);
  console.log(`DISCOVERED: name=${svc.name} host=${svc.host} port=${svc.port} txt=${JSON.stringify(svc.txt)}`);
  const ok = svc.name === 'mdp-node-spike' && svc.port === 7900 && svc.txt?.node_id === 'spike-node';
  console.log(ok ? 'PASS  mDNS 同主机广播+发现成功（含 TXT 元数据）' : 'FAIL  发现的服务元数据不符');
  service.stop();
  browser.stop();
  bonjour.destroy();
  process.exit(ok ? 0 : 1);
});

setTimeout(() => {
  console.log('FAIL  10s 内未发现服务（Windows 防火墙/多播被拦或实现问题）');
  bonjour.destroy();
  process.exit(1);
}, 10000);
