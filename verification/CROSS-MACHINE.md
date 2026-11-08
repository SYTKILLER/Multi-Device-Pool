# 跨机联调指南（V3 余项 + V5 延伸）

> 日期：2026-11-08。对应 `docs/verification-p0.md` 的 V3 余项（跨机 mDNS 发现）与 V5 延伸（跨机 exec/fs）。
> 机器 A（本机，hub 侧）：Windows 11，LAN IP `192.168.1.42`（以实测为准，DHCP 可能变化——用 `ipconfig` 复核）。
> 机器 B（第二台设备）：任意 Node ≥ 20 的 PC/Mac。
>
> **安全注记**：P0 的 hub↔node 通道为**明文 TCP**（TLS1.3 + root 签名证书体系是 P0→P1 收尾项，01 §2.1/§5.1）。
> 本指南仅限**可信局域网**内演示使用；跨公网/不可信网络前必须先落 TLS。

---

## 0. 前置检查（两台机器各自执行）

```bash
node --version          # ≥ 20（实测环境 24.18.0）
git --version
```

同一局域网：机器 B `ping 192.168.1.42` 通（不通先查路由/AP 隔离）。

## 1. 两台机器拉取代码并构建

```bash
git clone https://github.com/SYTKILLER/Multi-Device-Pool.git
cd Multi-Device-Pool
npm install && npm run build
npm run v5              # 机器 B 本机自证：35/35 PASS 说明环境完好
```

## 2. 机器 A：防火墙放行 + 启动 hub

Windows 防火墙首次弹窗时选"允许"，或显式加规则（**需管理员 PowerShell**）：

```powershell
netsh advfirewall firewall add rule name="mdp-hub-node" dir=in action=allow protocol=TCP localport=7900 program="<node.exe 绝对路径>"
netsh advfirewall firewall add rule name="mdp-mdns-udp" dir=in action=allow protocol=UDP localport=53550
```

> 查 node.exe 路径：`where node`（通常 `C:\Program Files\nodejs\node.exe`）。

启动 hub（默认 MCP :7800 / 节点 :7900，令牌写 `~/.mdp/hub-info.json`）：

```bash
npm run hub
```

## 3. 机器 B：入池

```bash
npm run node -- --hub 192.168.1.42:7900 --name pc2 --ws repo=<设备B上某目录的绝对路径>
```

- 日志出现 `已连接 hub …（node_id=…）` 即入池成功；机器 A 的 hub 控制台出现 `节点上线：pc2 …`。
- 身份持久化在 `~/.mdp/`（node-key.json），重启进程/机器 node_id 不变（01 §2.3）。

## 4. 验证一：V3 余项——跨机 mDNS 发现（零依赖，与 hub 无关）

两个终端分别跑（可 A 广播 / B 侦听，或对调）：

```bash
# 机器 A
node verification/v3-mdns/advertise.mjs
# 机器 B
node verification/v3-mdns/browse.mjs
```

预期：B 收到 A 的 JSON announce（组播 239.255.77.68:53550，显式绑接口）。收不到 → 防火墙 UDP 53550 / 多网卡（V3 已证明显式绑接口是必须项，两脚本均已处理）。

## 5. 验证二：V5 延伸——跨机 exec/fs（在机器 A 上操作）

> **⚠️ 工具坑（2026-11-08 跨机实测踩中）**：Windows 版 **curl 会把命令行参数按 ANSI 代码页（GBK）转码进请求体**——JSON 里带中文的 curl 示例会在 A 侧就变成 GBK 字节，hub 按 UTF-8 有损解码后落盘全是 U+FFFD。**带中文的请求一律用 node fetch（或 `curl --data-binary @文件`，文件以 UTF-8 落盘）**。ASCII 命令的 curl 不受影响。

**方式 a（快速，node fetch 一把梭）**：

```bash
node -e "
const H={'Content-Type':'application/json',Authorization:'Bearer '+process.argv[1]};
const call=(name,args)=>fetch('http://127.0.0.1:7800/mcp',{method:'POST',headers:H,
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}).then(r=>r.json()).then(j=>JSON.parse(j.result.content[0].text));
(async()=>{
  const n=await call('nodes',{});
  console.log(JSON.parse(n.result.stdout).nodes.map(x=>x.display_name+':'+x.online).join(', '));  // 期望含 pc2:true
  const e=await call('exec',{node:'pc2',cmd:'node -e \"console.log(6*7)\"',cwd:'workspace:repo'});
  console.log(e.status, e.result.stdout);   // 期望 ok / 42
  const w=await call('fs',{node:'pc2',op:'write',path:'workspace:repo/跨机测试.txt',content:'中文-abc'});
  const r=await call('fs',{node:'pc2',op:'read',path:'workspace:repo/跨机测试.txt'});
  console.log(JSON.parse(w.result.stdout).written, r.result.stdout);  // 期望 9 / 中文-abc
})();
" "$(node -pe "JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.mdp/hub-info.json','utf8')).token")"
```

**方式 b（真实 harness，V5 本体闭环）**：机器 A 桌面端 ZCode 打开仓库 → 信任根 `.mcp.json`（mdp = attach 桥）→ 会话里说"列出池内节点，在 pc2 上读 workspace:repo 下的目录并跑一条命令"。

## 6. 断线/对账演练（可选，journal 跨机语义）

1. 机器 B 起一个长任务（`Start-Sleep -Seconds 60`）。
2. 强杀机器 B 的 node 进程（任务管理器 / `kill -9`）。
3. 机器 A 侧调用应得 `unknown` + 禁止重发指引；重启 B 后自动重连、同 node_id 恢复（V5 T26/T29 已证）。

## 7. 结果回填

把以下结果写回 `docs/verification-p0.md`：
- V3 行：跨机 browse 收到 announce ✓/✗（含防火墙处理记录）
- V5 行：跨机 pc2 exec/fs 实测 ✓/✗；真实 ZCode 会话调用 ✓/✗

## 8. 常见故障

| 症状 | 处置 |
|---|---|
| B 连接失败 ECONNREFUSED | A 的 hub 未启动，或 7900 未放行（§2 防火墙） |
| B 已连接但 A 看不到节点 | 两边系统时间偏差过大（>分钟级）不影响；查 B 的 `--hub` 地址/端口 |
| mDNS browse 无输出 | UDP 53550 未放行；或设备在不同网段/AP 隔离 → 换手机热点或直连网线再试 |
| exec 返回 GBK 乱码 | 机器 B 是 Windows：节点已按 V2 包装 PowerShell；若 `--shell cmd` 则按设计走 GBK 解码兜底 |
