# P1 任务看板（双机并行开发）

> 机器 A = 192.168.1.42（WLAN，P0 hub/node 作者）；机器 B = 192.168.1.88（以太网，P0 验证/contract 作者）。
> 本看板是双机的**共享协调面**（两机的本地记忆互不相通，仓库即共享记忆）。每次 push 必须让本文件与代码状态一致。

## 协作协议（双机共同遵守）

1. **包所有权**：按下方任务表认领；不碰他人名下包的文件（新包认领后归认领者）。
2. **contract 冻结**：`@mdp/contract` 类型变更本轮归 **A 机**所有并负责递增 `manifest_version`；B 机只消费。类型需求写进文末「契约变更请求」区，等对方推送，**不直接改**。
3. **主线纪律**：开工前 `git pull`；小步提交；push 前 `npm run verify`（或本机等效全套）必须绿；完成一项 = 代码 + 本看板状态 + 验证记录一个 commit。
4. **设计决策不并行**：实现一律按 `docs/01-技术方案-v0.1.md` 冻结条款执行；发现规格缺口/矛盾 → 写进「决策请求」区登记并停下该部分，**决策由用户拍板**（B 机的 ZCode 会话为决策中枢，A 机经用户转达）。
5. **互审门**：每项完成后由**另一台机器** pull 复核 + 全套 verify 在自己环境跑绿，才在看板勾「互审 ✓」——两台机器的环境差异（网卡/区域设置/杀软）本身就是测试资源。
6. **P1 集成验收口径**（01 §10）：双机各自 verify 全绿 + 跨机三节点演练（A hub + A 本机 node 双进程 + B 真节点）通过后，P1 宣告完成。

## 任务分区

| # | 任务 | 包/位置 | 认领 | 状态 | 验收标准 |
|---|---|---|---|---|---|
| P1-1 | overlay 全量：等级轴（deny<read-only<workspaces<allowlist<full）+ realpath 路径域 + exec cwd 夹紧 | packages/node | **A** | ✅ **完成（B 机互审通过 2026-11-09）**：代码走查（realpath/大小写折叠/`..` 词法折叠/域前缀 path.sep 防碰撞）+ 合并后 B 机全套跑绿（V5 40/40 + 三包单测） | V5 新增：symlink 逃逸被拒、`..` 相对路径被拒、大小写折叠生效（红队 P1-11） |
| P1-2 | 内容闸模式表 + 学习式白名单（首次前缀审批 → `command_patterns_allow` 累积） | packages/node + hub | **A** | 待认领 | 审批卡批准"记住前缀"后，同类命令免批；模式表每节点可编辑 |
| P1-3 | 自述注入：自由文本按不可信包裹 + **审计对账自动降级**（自述只读但审计见写 → 降级+告警） | packages/hub | **A** | 待认领 | nodes() 返回的自述带不可信标记；构造只读自述+写操作 → 自动降级触发 |
| P1-4 | 版本协商握手（hello 带 version+capability flags；低于最低版禁用相关工具并 GUI 提示） | packages/hub + node | **A** | 待认领 | 降级模拟旧 node 入池 → exec 禁用、fs 仍可用、提示文案出现 |
| P1-5 | 审计哈希链：node JSONL 链式哈希 + hub 定期拉取锚定；result hash = sha256(stdout+stderr+exit) | packages/node + hub | **A** | 待认领 | 篡改任一条历史日志 → 链校验失败可检出 |
| P1-6 | `mdp node stop` 进程树管理：PID 文件 + `taskkill /T`；`mdp hub stop` 同构 | apps/cli + packages/node | **A** | 待认领 | stop 后无孤儿（netstat 验证）、hub 显示离线；**直接 node 调用无孤儿、npm 包装链有孤儿**——实现注释引用 verification-p0.md §6 |
| P1-7 | adapter-direct：**单播直投发现**（主路径，V3 定论）+ 手写 dgram mDNS（同介质优化，显式绑接口） | packages/adapter-direct（新建） | **B** | ✅ **完成（B 机 2026-11-09，待 A 互审）** | 测试 6/6 ×3 稳定（unicast 往返/重试/耗尽回退 + 组播发现/dedup/TTL 下线）。实现要点：sweeper 间隔自适应 TTL/2；多播逐接口 setMulticastInterface+loopback；载荷 1KB 硬上限+严格 parse。**实现说明：同介质路径为自定义 announce 协议而非 DNS-SD（见决策请求 #1）** |
| P1-8 | GUI 骨架：节点/健康/审批卡（倒计时）/overlay 设置；Vite+React+TS，token 认证（红队 P0-3） | apps/gui（新建） | **B** | 待认领 | 浏览器内完成一次完整审批流程（TTL 倒计时可见） |
| P1-9 | ZCode 插件化：plugin.json（mcpServers + skill + ui 面板）+ 打包脚本 | apps/zcode-plugin（新建） | **B** | 待认领 | 桌面端安装 → 信任 → 会话内调 pc2 exec 成功（**顺路补 P0 末项验收**） |
| P1-10 | transfer 包起步：manifest walk 双层过滤（gitignore 管体积 / 秘密扫描硬排除）+ symlink 不跟随 | packages/transfer（新建） | **B** | ✅ **完成（B 机 2026-11-09，待 A 互审）** | 测试 4/4 ×3 稳定（分桶端到端 + sha256 抽验 + gitignore-lite 语义 + 容错）。两处规格符合性修正：`*.lock` 不入默认体积层（Cargo.lock 是合法文件，01 §5.2 活锁清单仅 `.git/*.lock`+swap）；lockfile 判定先于体积层，独立成桶。symlink：内链→refs 不跟随，外链→refs+excluded(symlink-out) |

> 平衡说明：A 机 6 项集中在既有 hub/node 包（P0 上下文在手）；B 机 4 项全是新包（adapter/GUI/插件/transfer）。认领有异议直接改表推送——看板即事实。

## 契约变更请求（A 机处理，处理完删行）

| 日期 | 请求方 | 内容 | 状态 |
|---|---|---|---|
| 2026-11-09 | B | `AnnouncePayload` schema + 发现端口常量（单播 UDP 7900 与 TCP 同号、组播 239.255.77.68:53550）迁入 `@mdp/contract`（现暂居 packages/adapter-direct/src/protocol.ts）——A 接线 hub/node（P1-3/P1-4）时需要 | 待处理 |

## 决策请求（等用户拍板，拍板后移入 01 文档修订并删行）

| 日期 | 提出方 | 议题 | 状态 |
|---|---|---|---|
| 2026-11-09 | B | 01 §5.1 的"mDNS（_mdp._tcp）"修订为"**自定义组播 announce 协议**（JSON over UDP 239.255.77.68:53550）"：两端皆为池软件、无需 OS 级互操作；显式绑接口是 V3 强制约束（自定义协议下实现最直接）；DNS-SD 线格式编码是纯开销。代码已按自定义协议交付，如否决再补 DNS-SD | 待拍板 |
