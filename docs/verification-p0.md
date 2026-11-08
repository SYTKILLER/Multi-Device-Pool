# P0 验证清单结果（V1–V6）

> 日期：2026-11-07。环境：Windows 11 中文系统，Node 24.16.0，ZCode 0.17.1。
> 对应 01 技术方案 §12 的验证清单。每项标注：✅ 完成 / ◐ 部分完成（余项待用户协助）/ ⬜ 未开始。

## 总览

| # | 验证项 | 状态 | 核心结论 |
|---|---|---|---|
| V1 | ZCode 接入面（list_changed / MCP 审批） | ◐ | 静态：`autoRefresh` 默认开启、transport 支持 **stdio/http/sse**；动态：无头模式不加载工作区声明，需桌面端信任一次 |
| V2 | PowerShell/cmd 中文编码 | ✅ | **chcp 65001 对管道输出无效**；`[Console]::OutputEncoding=UTF8` 前缀是唯一有效通路（stdout+stderr 双路） |
| V3 | mDNS 局域网发现 | ◐ | 本机回环 PASS，但**必须显式绑定接口**（默认多播路由 EHOSTUNREACH）；跨机待第二台设备 |
| V4 | journal 对账 | ✅ | 5/5 PASS：四场景裁决正确，原子写经受 SIGKILL |
| V5 | ZCode/DSH 并挂 hub | ◐ | **2026-11-08：hub/node 最小版实现完成，同机双进程 35/35 PASS**（exec/fs 全链路 + 失败信封全分类 + 双 MCP 客户端隔离/审批合并）；真实 ZCode 桌面端一键步骎见文末 |
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
**余项（待用户协助）**：第二台真实设备上的跨机发现——脚本已备：设备 A 跑 `node advertise.mjs`，设备 B 跑 `node browse.mjs`（组播 239.255.77.68:53550，JSON announce，显式绑接口，零依赖）；需确认 Windows 防火墙对 node.exe 的 UDP 入站（5353/53550）放行。

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

**待用户协助（约 2 分钟，真实 harness 闭环）**：
> 1. 终端 `npm run hub`（写 `~/.mdp/hub-info.json`，默认端口 7800/7900）。
> 2. 桌面端 ZCode 打开本仓库 → 首次会话信任根 `.mcp.json`（mdp = attach 桥，自动读令牌）→ 直接说"列出池内节点并在 pc-test 上跑 `echo hello`"。工具名 `mcp__mdp__nodes / exec / fs / job_*`。

**真实第二台机器**：与 V3 余项合并——hub 起于主机，子机 `npm run node -- --hub <主机IP>:7900 --name pc2 --ws repo=<路径>`（mDNS 自动发现 hub 为 P1 项，v1 先手输）。
