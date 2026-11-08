# P0 验证清单结果（V1–V6）

> 日期：2026-11-07。环境：Windows 11 中文系统，Node 24.16.0，ZCode 0.17.1。
> 对应 01 技术方案 §12 的验证清单。每项标注：✅ 完成 / ◐ 部分完成（余项待用户协助）/ ⬜ 未开始。

## 总览

| # | 验证项 | 状态 | 核心结论 |
|---|---|---|---|
| V1 | ZCode 接入面（list_changed / MCP 审批） | ◐ | 静态：`autoRefresh` 默认开启、transport 支持 **stdio/http/sse**；动态：无头模式不加载工作区声明，需桌面端信任一次 |
| V2 | PowerShell/cmd 中文编码 | ✅ | **chcp 65001 对管道输出无效**；`[Console]::OutputEncoding=UTF8` 前缀是唯一有效通路（stdout+stderr 双路） |
| V3 | mDNS 局域网发现 | ✅ | 本机回环 PASS（**必须显式绑定接口**，默认多播路由 EHOSTUNREACH）；**跨机定论（2026-11-09）**：单播 4/4 到达、组播 0/4 到达 → **AP 过滤 WLAN→以太网跨介质组播**（B 防火墙已排除：node.exe UDP 入站规则本就存在）。设计修订：**adapter-direct 发现以单播直投 announce 为主路径**，mDNS 降为同介质优化 |
| V4 | journal 对账 | ✅ | 5/5 PASS：四场景裁决正确，原子写经受 SIGKILL |
| V5 | ZCode/DSH 并挂 hub | ◐ | **2026-11-08：hub/node 最小版实现完成，同机双进程 35/35 PASS**；**跨机实测同日 PASS**（pc2 入池，exec/fs/中文全通过，RTT 3-8ms）；**§6 断线演练跨机复现 PASS（2026-11-09）**——SIGKILL→unknown（journal 停 started）→同 node_id 重连→恢复；余项：真实 ZCode 桌面端闭环 |
| V6 | DSH 多 MCP 热插拔 / 会话跨机回放 | ⬜ | 沿用 00 附录 B，P0 后半段 / P5 前 |

---

## V1 · ZCode 接入面 ◐

**静态实查（bundle 15.4MB，版本 0.17.1）——已确认：**

1. `notifications/tools/list_changed` 有完整客户端实现 + **`autoRefresh` 默认 `true`**（带 `debounceMs`）→ 动态工具表刷新是成熟能力，per-node 前缀工具组方案成立。
2. MCP client transport schema：`m.enum(["stdio","http","sse"])` → **修正 01 文档 §1.3**：ZCode 并非 stdio-only，hub 可直接以 HTTP 挂载（`mdp attach` stdio 桥降为备选）。
3. 内置工具策略引擎字段：`needsApproval` / `sideEffectScope` / `denyPriority:"beforeAsk"` / `patternSources:["toolName"|"path"]` / `alwaysAllowPatternSources` / `resultBudget` → 自述读取器（P1 阶段）应读这些结构。
4. 项目级 MCP 声明有两个源：**`.mcp.json` 与 `.agents/mcp.json`**（形状 `{mcpServers:{...}}`）；cwd 缺省 = 项目根。
5. 信任模型：`workspace/mcp/trust` 协议消息；信任存储 `~/.zcode/cli/workspace-mcp-trust-v1.json`，记录 `{workspaceIdentity, serverName, declarationDigest(sha256, 递归键排序 canonical JSON), grantedAt}`；`.mcp.json` 变更即 digest 变化需重新信任。

**动态验证（无人值守尝试）——受限：**

- `zcode -p`（无头，默认 yolo 模式）**不加载工作区级 MCP 声明**（`.mcp.json` 与 `.agents/mcp.json` 均未生效，子会话只见插件级服务器）。
- 判读：这是合理的安全默认（无人值守不应自动执行项目声明的任意命令），但也意味着**动态验证需要一次人工操作**：

> **待用户协助（约 2 分钟）**：在桌面端 ZCode 打开 `D:\Projects\Multi-Device-Pool\verification\v1-mcp\`，首次会话会弹 `.mcp.json` 信任提示 → 批准 → 调用 `mcp__ping__ping` 应返回 `pong-<时间戳>`；等 15 秒后调用 `mcp__ping__ping2`（服务器 12 秒后自动新增并发 list_changed）→ 返回 `pong2-<时间戳>` 即证明 autoRefresh 生效。

**对 P0 的影响**：静态证据已足以开工（自动刷新为默认行为）；若动态测试失败，静态工具面（node 参数化）是已冻结的兜底，方案不受损。

## V2 · Windows 中文编码 ✅

脚本：`verification/v2-encoding.mjs`、`v2b-encoding.mjs`。结果：

| 用例 | 结果 |
|---|---|
| cmd 默认 codepage | ✗ GBK（utf8 解码乱码） |
| **cmd + chcp 65001（带/不带 >nul）** | ✗ **chcp 报告切页成功但输出仍 GBK——管道模式下对内部命令无效** |
| powershell 5.1 默认 | ✗ GBK |
| **powershell 5.1 + `[Console]::OutputEncoding=UTF8` 前缀** | ✓ stdout、**stderr 同样有效** |
| pwsh 7 默认 | ✗ **pwsh7 管道下默认也是 GBK** |
| pwsh 7 + 前缀 | ✓ |
| git 中文文件名 | ✓（八进制转义是 `core.quotepath` 行为，`-c core.quotepath=false` 可解，非编码问题） |

**设计修订（已写入 01 §4.2）**：原"cmd 走 chcp 65001 包装"废弃；Windows exec 改为 **PowerShell 前缀包装**（`[Console]::OutputEncoding=[Text.Encoding]::UTF8; <cmd>`），PS5.1/pwsh7 通吃；shell=cmd 时按系统 codepage（GBK）解码兜底；git 类命令建议带 `-c core.quotepath=false`。

## V3 · mDNS ◐

脚本：`verification/v3-mdns/`。结果链：

1. `bonjour-service` 广播+发现（默认接口）→ 10s 超时 ✗
2. 裸 dgram 隔离：`addMembership` → **`EHOSTUNREACH`**（默认多播接口路由不可达——本机多网卡/虚拟网卡环境）
3. **显式指定接口**（`os.networkInterfaces()` 枚举 + `addMembership(group, ifaceIP)`）→ 多播回环 5/5 收到 ✓

**设计修订**：adapter-direct 的 mDNS **手写 dgram 实现**（bonjour-service 不支持指定接口，弃用）：节点与 hub 必须枚举本机 IPv4 接口逐一绑定/加组，绝不依赖默认多播路由。
**跨机定论（2026-11-09，A=WLAN 192.168.1.42 / B=以太网 192.168.1.88）**：

- A `advertise.mjs` 持续广播（自身回环 DISCOVERED ✓）；B `browse.mjs` 两接口入组后 **0 包到达**。
- 判别实验：A→B:53551 **单播** UDP 探针 **4/4 到达**（payload 原样）——IP 层连通完好。
- B 防火墙排除：`netsh` 证实 `C:\Program Files\nodejs\node.exe` 的 UDP 入站允许规则本就存在（专用+公用、任意端口、路径精确匹配）。
- **定论**：AP 在 WLAN→以太网方向过滤组播帧（IGMP Snooping/组播增强类行为）。次要嫌疑 B 的 Hyper-V/WSL 虚拟交换机无法单变量排除，但判别结论不变：**组播发现不可作为跨介质依赖**。
- **设计修订（adapter-direct 实现说明，不动 P0 代码）**：发现以**单播直投 announce**（hub IP 已知时直发）为主路径；mDNS 仅作同介质优化；手输地址保持兜底。与 01 §5.1"LAN 直连一等公民"不冲突——直达通道与发现机制分离。

## V4 · journal 对账 ✅

脚本：`verification/v4-journal/`（journal.mjs 是 `@mdp/node` 的实现蓝本）。5/5 PASS：

| 场景 | 裁决 | 断言 |
|---|---|---|
| started 后 SIGKILL | `unknown_reconcile` | ✓ 禁止重发 |
| received 后 SIGKILL | `safe_redispatch` | ✓ 可透明重发 |
| 正常完成 | `result_available` | ✓ |
| 从未派发 | `never_seen` | ✓ |
| 强杀后 journal 文件完整性 | 原子写（tmp+rename）存活 | ✓ |

**真实 OS 睡眠/唤醒演练**（TCP 静默死 + power-resume 事件）仍待用户协助（需要真的合盖一台笔记本）。

---

## P1 开发验证（双机并行，看板 docs/p1-board.md）

### P1-1 overlay 全量 ✅（2026-11-09，A 机，V5 40/40）

- **等级轴实装**（contract `LEVEL_ORDER`/`levelAtLeast`/`STANDARD` 预设）：fs 读类 ≥ read-only、写类 ≥ workspaces（allowlist 轴对 fs 与 workspaces 同义——写仍限路径域）；exec ≥ workspaces 需 cwd 在路径域、= allowlist 时命令须命中学习式白名单。
- **overlay 归 hub 单一事实源**：hello 懒创建 standard 预设（域=该节点工作区）随 welcome 下发；`PATCH /nodes/:id/overlay` 合并持久化 + **在线节点即时推送**（节点 `overlay` 帧即时生效，01 §3.2）；`nodes()` 摘要带 overlay 状态。
- **路径域硬化**（红队 P1-11）：realpath 判定 + 符号链接逃逸拒绝（junction 实测）+ `..` 穿越拒绝（词法折叠后域检查）+ **Windows 大小写折叠**。
- **V5 新增 T35–T39**：symlink 逃逸 / `..` 穿越 / 全大写形态路径写放行（折叠）/ overlay REST 编辑→exec=deny 即时拒→allowlist 白名单命中放行未命中拒→fs=read-only 写拒读放行→还原 workspaces / GET 回读。
- 过程回归修复：重构初版把 busy 折进 deny——已恢复 01 §4.3 独立 `busy` 分类（`failed + class:busy`），T11 守住。

### P1-2 内容闸模式表 + 学习式白名单 ✅（2026-11-09，A 机，V5 43/43）

- **学习式白名单闭环**（01 §3.2）：审批 REST 带 `{remember:true}` → hub 提取命令前缀（前两个空白 token，`extractCmdPrefix`；可显式传 `prefix` 覆盖）→ 去重累积进该节点 `overlay.command_patterns_allow` → 即时推送 → 同前缀命令免批；不同前缀危险命令仍转审批、可 deny。
- **模式表每节点可编辑**：`PATCH /nodes/:id/overlay` 传 `content_gate_patterns`（正则源数组）**整体覆盖**内建初版集；置空还原内建。
- **V5 新增 T40–T42**：remember→免批全链 / 不同前缀仍拦可 deny / 自定义表覆盖后内建 `dd` 不再拦截、自定义 MARKER 命中转审批。
- 审计挂钩：`job.remembered_prefix` 随审批记录留存（approver + prefix），供 P1-5 审计链与 P1-3 对账使用。

### P1-4 版本协商握手 ✅（2026-11-09，A 机，V5 44/44）

- hello 本就携带 `manifest.agent_version` + `capabilities`（P0 结构已备）；本任务补 **hub 侧最低版本表强制**（`FEATURE_MIN`：exec≥0.1.0、fs≥0.0.1、transfer=P2 前恒不可用；`compareVersions` 数值逐段比较）。
- 低于最低版：该能力调用在 **hub 侧预检拒绝**（不发往节点）→ `failed + permission（永不重试）` + 升级提示；`nodes()` 每节点返回 `features{exec,fs,transfer}`（available/min/agent/hint）——GUI 提示与 LLM 决策共用同一事实源。
- 模拟钩子：node 侧 `MDP_AGENT_VERSION` 环境变量伪造旧版本（仅验收用）。
- **V5 T43**：0.0.9 旧节点入池 → exec 拒（提示含"低于 exec 最低"）、fs read 照常、nodes() 特性状态正确。
- 插曲（记录在案）：快照重复字段被 tsc 抓出，但 `noEmitOnError` 未开导致 JS 照常产出、测试先绿——**教训：构建错误必须零容忍，verify 链前置干净构建检查**（已在本轮 verify 口径执行）。

### P1-7 / P1-10 互审 ✅（2026-11-09，A 机审 B 机交付）

- **adapter-direct（P1-7）**：A 机 build + test 6/6 全绿；走查通过——`protocol.ts` 1KB 双向硬上限 + 严格 parse（proto/kind/role/name/id/ts 校验，红队输入限制）；`unicast.ts` reply 源地址校验（只信目标主机）+ 重试/超时/pending 守卫；`multicast.ts` 逐接口 `setMulticastInterface`+loopback、全接口加组（V3 强制约束）、TTL 自适应 sweeper + dedup。非阻塞 nit 已回写看板供 B 参考。
- **transfer（P1-10）**：A 机 build + test 4/4 全绿；走查通过——双层过滤（体积/秘密硬排除）语义正确、`*.lock` 规格修正成立（01 §5.2 活锁清单确为 `.git/*.lock`+swap，Cargo.lock 属合法文件）、symlink 内链 refs/外链 refs+excluded 分桶、决定性排序 + 流式 sha256。非阻塞 nit：`secretContentHit` 全量读文件后截 8KB（大文件内存尖峰，建议 P2 流式窗口）、`void ignoreFiles` 死代码、`crt\.$` 正则形态存疑（.crt 公钥本不敏感，影响极小）。
- **契约变更请求已处理**：`AnnouncePayload` schema + 发现端口常量迁入 `@mdp/contract@0.2.0`（`src/discovery.ts`，纯类型常量零逻辑）；adapter-direct 接线由 B 自行完成。

## V5 / V6

### V5 · hub/node 最小实现与集成验收 ◐（2026-11-08）

**交付**：`packages/hub`（@mdp/hub：节点协议端点 /mcp /nodes /jobs REST、审批 job + TTL、信封裁决、attach 桥）、`packages/node`（@mdp/node：overlay 三检 + journal + exec/fs + manifest 签名上报）、`@mdp/contract` 单元测试 6/6。脚本：`verification/v5-hub/test-v5.mjs`（`npm run v5`）。

**测试（35/35 PASS，复跑稳定）**——同机双进程（hub daemon + node agent）+ 双 MCP 客户端并挂：

| 块 | 覆盖 | 结果 |
|---|---|---|
| 接入 | initialize / tools/list 静态基线 7 工具 / nodes() manifest 摘要 | ✓ |
| exec | UTF-8 中文 stdout+stderr（V2 通路端到端）、退出码透传 | ✓ |
| **信封全分类** | ok / timeout / **denied(permission，永不重试)** / **failed(crash)** / **failed(busy，index.lock)** / **failed(offline)** / **unknown(network，禁止重发指引)** / needs_approval | ✓ 全分类 |
| 审批 | needs_approval → REST 批准 → 续跑 finished；**TTL 到期默认 deny** | ✓ |
| 后台 job | submit 即回 / running 期增量 output / status / cancel | ✓ |
| journal | 节点 SIGKILL 在途调用 → unknown + journal 停在 started（对账依据）；重启同 node_id 自动重连恢复 | ✓ |
| **V5 本体** | 双 MCP 客户端并发互不串扰；A 触发的审批卡 B 可见、单次批准双侧读到终态（审批合并） | ✓ |
| 安全 | 无令牌 401（红队 P0-3）；fs 越界 overlay 拒绝（路径域 + 符号链接逃逸） | ✓ |
| attach 桥 | stdio ↔ HTTP 透传 initialize | ✓ |

**过程中发现并修复的实现缺陷（记录在案）**：
1. `/nodes` REST 双重包裹 `{nodes:{nodes:[…]}}` → 摘掉外层。
2. `job_continue` 续跑时节点重新过内容闸又转审批 → continue 帧带 approved 标记，人工放行仅跳过 approval（deny/busy 检查保留）。
3. job_cancel 竞态：hub 乐观落地 cancelled，节点 job_update 覆盖确认。
4. Ed25519 验签必须 `createPublicKey({key: der, format:'der', type:'spki'})`，裸 DER Buffer 会 DECODER 报错。
5. journal 目录归位 `~/.mdp/jobs/`（01 §4.3）。

**P0 验收对照（01 §10）**：同机双进程 exec/fs + 失败信封全分类 ✅。**P0 后半段余项**：GUI 骨架（审批 REST 已就位作其代理）、per-node 前缀组与 list_changed 推送（P1）。

**跨机实测（2026-11-08，同日）**：第二台设备（Win10，`pc2`，node_id `ffdc6faf1638d552`）经 `npm run node -- --hub 192.168.1.42:7900 --name pc2 --ws repo=<路径>` 入池（RTT 3-8ms）。A 侧经 hub MCP 实测：exec `6*7`→`42`（信封完整）、fs 中文写/读逐字节一致（45 字节）、exec 中文经 PowerShell UTF-8 前缀（V2 结论在真第二台机器复现）。**工具坑**：Windows 版 curl 会把命令行参数按 ANSI 代码页（GBK）转码进请求体——带中文的 JSON 请求必须在 A 侧用 node fetch（或 `--data-binary @file`），已在指南 §5 记录；池传输本身字节无损（hexdump 取证：磁盘 U+FFFD 源自 curl 侧 GBK 转码，非 hub/node）。

**待用户协助（约 2 分钟，真实 harness 闭环）**：
> 1. 终端 `npm run hub`（写 `~/.mdp/hub-info.json`，默认端口 7800/7900）。
> 2. 桌面端 ZCode 打开本仓库 → 首次会话信任根 `.mcp.json`（mdp = attach 桥，自动读令牌）→ 直接说"列出池内节点并在 pc-test 上跑 `echo hello`"。工具名 `mcp__mdp__nodes / exec / fs / job_*`。

**真实第二台机器**：与 V3 余项合并——hub 起于主机，子机 `npm run node -- --hub <主机IP>:7900 --name pc2 --ws repo=<路径>`（mDNS 自动发现 hub 为 P1 项，v1 先手输）。

### §6 断线/对账演练（跨机实录，2026-11-09）✅

按 CROSS-MACHINE.md §6 执行，A（hub 侧）与 B（节点侧=本机）两侧记录互证：

| 步骤 | 结果 |
|---|---|
| A 提交长任务 `Start-Sleep 300`（timeout 280s） | pc2 开始执行，journal 落 `started`；击杀前另一条探针 exec 正常返回 ok |
| B 强杀 node 进程 | **两次击杀**：TaskStop 只杀 npm 包装，node 子进程成孤儿（连接仍 ESTABLISHED）→ 补刀 `taskkill /F /PID`（TerminateProcess，SIGKILL 语义）后连接清零 |
| A 侧终态 | `{status:"unknown", call_id:"c-mw80ltmp-14-h8tdgg", error:{class:"network", retryable:false, message:"节点在调用期间断连：结局不明（journal 对账后可续），禁止盲目重发"}}` —— 与 B 侧 journal 冻结记录（`started`，received→started 无 finished）逐字段互证 |
| B 重启 | **同 node_id `ffdc6faf1638d552`** 自动重连，hub 欢迎 epoch=1（T29 跨机复现；hub 日志时间线：上线→离线仅一次（补刀瞬间）→同 id 上线） |
| A 恢复验证 | 干净重跑 exec：`ok exit=0 stdout="42\n"`；跨机中文无损回传（T30） |

**附注**：恢复验证时一条探测曾 `exit=1` 空输出——系 A 侧命令嵌套引号被 PS 包装层吃掉（命令自身报错），信封如实透传退出码，属**行为正确**的证据而非异常。

**流程发现 → P1 待办**：
1. **"停 npm 包装 ≠ 停 node agent"**：Windows 上杀父进程留下孤儿子进程且 hub 连接保持、`/nodes` 仍显示 online——hub 日志证实 TaskStop 期间零离线事件。**P1 待办**：`mdp node stop` 必须按进程树杀（`taskkill /T`）或 node agent 自持 PID 文件；hub 健康语义维持"socket 存活=在线"（对半死节点是诚实的），辅以心跳超时（已有）。
2. curl GBK 坑（上文跨机实测段）与 V2 发现同族：**非 ASCII 载荷的 REST 示例统一用 node fetch**，写入 P1 GUI/API 文档规范。
