# P1 任务看板（双机并行开发）

> **P1 已宣告完成（2026-11-15）**：P1-1~11 全部完成且互审闭环（B 机互审通过 P1-11 修复，V5 54/54）；集成验收达成（e71e080：三节点演练 + 双机 verify 全绿）。本看板转为 P2 任务表（P2-1~4）。


> 机器 A = 192.168.1.42（WLAN，P0 hub/node 作者）；机器 B = 192.168.1.88（以太网，P0 验证/contract 作者）。
> 本看板是双机的**共享协调面**（两机的本地记忆互不相通，仓库即共享记忆）。每次 push 必须让本文件与代码状态一致。

## 协作协议（双机共同遵守）

1. **包所有权**：按下方任务表认领；不碰他人名下包的文件（新包认领后归认领者）。
2. **contract 冻结**：`@mdp/contract` 类型变更本轮归 **A 机**所有并负责递增 `manifest_version`；B 机只消费。类型需求写进文末「契约变更请求」区，等对方推送，**不直接改**。
3. **主线纪律**：开工前 `git pull`；小步提交；push 前 `npm run verify`（或本机等效全套）必须绿；完成一项 = 代码 + 本看板状态 + 验证记录一个 commit。
4. **设计决策不并行**：实现一律按 `docs/01-技术方案-v0.1.md` 冻结条款执行；发现规格缺口/矛盾 → 写进「决策请求」区登记并停下该部分，**决策由用户拍板**（B 机的 ZCode 会话为决策中枢，A 机经用户转达）。
5. **互审门**：每项完成后由**另一台机器** pull 复核 + 全套 verify 在自己环境跑绿，才在看板勾「互审 ✓」——两台机器的环境差异（网卡/区域设置/杀软）本身就是测试资源。
6. **P1 集成验收口径**（01 §10）：双机各自 verify 全绿 + 跨机三节点演练（A hub + A 本机 node 双进程 + B 真节点）通过后，P1 宣告完成。
   - ✅ **2026-11-14 达成并宣告**：三节点演练（a-local + pc2 各 exec/fs 中文逐字节 + a-local 干净退场）+ 双机 verify 全绿（A 机五链 + V5 53/53；pc2 经沙箱内五链 + V5 53/53，方法与取证见 `docs/verification-p0.md` P1 集成验收节）。附带真机发现：**Windows agent 后台 job stdout 恒空** → 已立 **P1-11**，A 机同日修复（agent 终态信封带 inline 摘要 + hub 终态后回节点取权威全量 + node-jobs 双 push；V5 新增 T48 回归，54 PASS / 0 FAIL，见任务表 P1-11，**待 B 机互审**）。P1-9 互审 B 机已完成（见任务表）。

## 任务分区

| # | 任务 | 包/位置 | 认领 | 状态 | 验收标准 |
|---|---|---|---|---|---|
| P1-1 | overlay 全量：等级轴（deny<read-only<workspaces<allowlist<full）+ realpath 路径域 + exec cwd 夹紧 | packages/node | **A** | ✅ **完成（B 机互审通过 2026-11-09）**：代码走查（realpath/大小写折叠/`..` 词法折叠/域前缀 path.sep 防碰撞）+ 合并后 B 机全套跑绿（V5 40/40 + 三包单测） | V5 新增：symlink 逃逸被拒、`..` 相对路径被拒、大小写折叠生效（红队 P1-11） |
| P1-2 | 内容闸模式表 + 学习式白名单（首次前缀审批 → `command_patterns_allow` 累积） | packages/node + hub | **A** | ✅ **完成（B 机互审通过 2026-11-09）**：走查 overlay 内容闸（allowlist 未命中→deny + 前缀计数）+ jobs.ts `remembered_prefix` 落审计；合并后 B 机 53/53 | 审批卡批准"记住前缀"后，同类命令免批；模式表每节点可编辑 |
| P1-3 | 自述注入：自由文本按不可信包裹 + **审计对账自动降级**（自述只读但审计见写 → 降级+告警） | packages/hub | **A** | ✅ **完成（B 机互审通过 2026-11-09）**：走查 selfdesc.ts——`UNTRUSTED_PREFIX` 显式包裹（红队 P1-9）+ 对账双条件（自述 fs 非 deny 但审计有写 / exec=deny 但审计有执行）→ 降级+告警，hub 拉取审计时触发；合并后 B 机 53/53 | nodes() 返回的自述带不可信标记；构造只读自述+写操作 → 自动降级触发 |
| P1-4 | 版本协商握手（hello 带 version+capability flags；低于最低版禁用相关工具并 GUI 提示） | packages/hub + node | **A** | ✅ **完成（B 机互审通过 2026-11-09）**：走查 version.ts（agent_version + capabilities 门槛表，基础能力低门槛、新能力随版本抬高——与静态工具面兜底策略一致）；合并后 B 机 53/53 | 降级模拟旧 node 入池 → exec 禁用、fs 仍可用、提示文案出现 |
| P1-5 | 审计哈希链：node JSONL 链式哈希 + hub 定期拉取锚定；result hash = sha256(stdout+stderr+exit) | packages/node + hub | **A** | ✅ **完成（B 机互审通过 2026-11-09）**：走查 audit.ts——seq 连续性 + prev_hash 链式 + 记录结构化哈希（篡改可检出）；hub 拉取即全链重验；合并后 B 机 53/53 | 篡改任一条历史日志 → 链校验失败可检出 |
| P1-6 | `mdp node stop` 进程树管理：PID 文件 + `taskkill /T`；`mdp hub stop` 同构 | apps/cli + packages/node | **A** | ✅ **完成（B 机互审通过 2026-11-09）**：走查 node/index.ts PID 文件生命周期 + cli killTree（注释引用 §6 教训）；合并后 B 机 53/53 | stop 后无孤儿（netstat 验证）、hub 显示离线；**直接 node 调用无孤儿、npm 包装链有孤儿**——实现注释引用 verification-p0.md §6 |
| P1-7 | adapter-direct：**单播直投发现**（主路径，V3 定论）+ 手写 dgram mDNS（同介质优化，显式绑接口） | packages/adapter-direct（新建） | **B** | ✅ **完成（B 机 2026-11-09）+ 互审 ✓（A 机 2026-11-09）**：A 机 build/test 6/6 全绿 + 走查通过——协议 1KB 双向硬上限与严格 parse（红队输入限制）、单播 reply 源地址校验、逐接口 setMulticastInterface+loopback、sweeper 自适应。非阻塞 nit 供 B 参考：① MulticastBrowser.start() joined=0 时仍 resolve（调用方宜检查）；② unicast 'error' 一律 finish(null)，端口占用与网络错不可辨（发现回退语义可接受）。**实现说明：同介质路径为自定义 announce 协议而非 DNS-SD（见决策请求 #1）** |
| P1-8 | GUI 骨架：节点/健康/审批卡（倒计时）/overlay 设置；Vite+React+TS，token 认证（红队 P0-3） | apps/gui（新建） | **B** | ✅ **完成（B 机 2026-11-09）+ 互审 ✓（A 机 2026-11-14）**：A 机 pull 后 tsc+vite 构建绿、verify 全链 53/53、代码走查通过（类型面与 hub REST 对齐、remember 前缀接 P1-2、overlay PATCH 双向、TTL 倒计时 tick 重渲、Bearer 认证）。非阻塞 nit 供 B 参考：① token 存 localStorage（骨架期可接受，P2 可考虑收窄存储面）；② OverlayPanel 节点默认值取挂载时首节点，列表晚到时需手动选。浏览器点击流验收随 P1-9 桌面端联调（与 B 范围说明一致） | 浏览器内完成一次完整审批流程（TTL 倒计时可见） |
| P1-9 | ZCode 插件化：plugin.json（mcpServers + skill + ui 面板）+ 打包脚本 | apps/zcode-plugin（新建） | **B** | ✅ **完成（B 机互审收尾通过 2026-11-14）**：复核 7c4dc03/06010fd/c7dd4cc——① 4 处修正全部成立且**优于原设计**（hub CLI 入口自执行带默认值语义、整 dist 拷贝保 ESM 闭包、marketplace source 必填、gitignore 前缀）；② **A 的注册表直写不持久发现采纳**：install-local.mjs 降级为"无头联调专用"，官方 UI 流程为唯一安装路径（A 已修订文档）；③ B 机重建后新入口冒烟 `mdp v0.1.0` + 合并后全套 53/53 + GUI nit（OverlayPanel 晚到列表自动选中）已修；④ docs 两提交与 B 侧证据互证（审计链 seq3 中文回显/字节级一致/RTT 4ms，见 B 机 journal+audit.jsonl）。B 机复刻提示（采纳 A 版）：UI 添加市场（市场根 apps/zcode-plugin）+ 先 `node scripts/build.mjs` 渲染本机 plugin.json | 桌面端安装 → 信任 → 会话内调 pc2 exec 成功（**✅ P0 末项验收达成**） |
| P1-11 | **真机缺陷修复**：Windows agent 后台 job stdout 恒空（job_submit/Write-Output → exit=0 空 stdout；V5 fake node 未暴露真机后台输出回传通路缺陷）；workaround=Start-Process 重定向落盘 + fs 轮询（e71e080 记录） | packages/node + hub | **A** | ✅ **修复完成（A 机 2026-11-14）+ B 机互审通过（2026-11-15）**：根因**双重缺陷**分析成立（agent 终态信封硬编码空 stdout + hub 终态后不回节点取权威全量），终态回节点/离线回退 inline 摘要的语义清晰，T48 补上测试盲区；B 机合并后 V5 **54/54** + 三包 20 单测全绿 | 真机 job_submit 后 job_output 轮询取回非空 stdout（Write-Output 冒烟）✓；V5 增真机语义用例 ✓（**T48**：终态全量回节点取 + 中文标记逐字节 + 终态信封摘要；V5 53→54 PASS / 0 FAIL） |
| P2-1 | **transfer 引擎全量**：分块（1 MiB）+ 逐块 sha256 + 断点续传（manifest 差量）+ staging 原子替换（预分配 `.mdp-part` 随机写 + finalize 全量校验 + rename） | packages/transfer | **B** | **WIP（B 机 2026-11-15）** | 单测：乱序分块 round-trip 字节一致、续传差量正确、坏块检出且不污染、finalize 全量哈希校验 |
| P2-2 | **血统接线**：transfer 成功 → revision++ / 源副本标 superseded（hub 持久化 + manifest 重报）；需 contract 0.3.0 增量 | packages/hub + node + contract | 待认领（A） | 待认领 | transfer 后 nodes() 显示 revision 递增 + 源副本 superseded=true；GUI 血统视图联动 |
| P2-3 | **Codex 适配**：config.toml `[mcp_servers.mdp]` url 挂载模板 + 静态工具面实测（Codex 工具表启动固定，节点上下线=运行时状态） | apps/codex-config（模板+文档） | 待认领（A 机装有 Codex 则 A，否则双方装后重分） | 待认领 | Codex 会话经 url 挂载调 nodes()/exec 成功；Desktop 覆写 config.toml 的检测提示 |
| P2-4 | **大载荷旁路工具**：本地文件 → hub MCP fs 推送 + 双侧 SHA256 比对的小工具（杜绝对话转录损坏，e71e080 坑 #3 落地） | apps/cli | 待认领 | 待认领 | 1MB 随机文件 B→A 推送后双侧哈希一致；>数 KB 提示走此工具 |
| P1-10 | transfer 包起步：manifest walk 双层过滤（gitignore 管体积 / 秘密扫描硬排除）+ symlink 不跟随 | packages/transfer（新建） | **B** | ✅ **完成（B 机 2026-11-09）+ 互审 ✓（A 机 2026-11-09）**：A 机 build/test 4/4 全绿 + 走查通过——双层过滤语义正确、`*.lock` 规格修正成立（01 §5.2 活锁清单确为 `.git/*.lock`+swap，Cargo.lock 合法）、symlink 内链/外链分桶符合红队要求、决定性排序+流式 sha256。非阻塞 nit 交 B：① `secretContentHit` 全量 readFile 后截 8KB（意图为头扫描，大文件内存尖峰，建议 P2 改流式窗口）；② manifest.ts `void ignoreFiles` 死代码；③ secrets 路径规则 `crt\.$` 形态存疑（.crt 公钥本不敏感，影响极小） | 单测 4/4 ×3 稳定（分桶端到端 + sha256 抽验 + gitignore-lite 语义 + 容错）。两处规格符合性修正：`*.lock` 不入默认体积层（Cargo.lock 是合法文件，01 §5.2 活锁清单仅 `.git/*.lock`+swap）；lockfile 判定先于体积层，独立成桶。symlink：内链→refs 不跟随，外链→refs+excluded(symlink-out) |

> 平衡说明：A 机 6 项集中在既有 hub/node 包（P0 上下文在手）；B 机 4 项全是新包（adapter/GUI/插件/transfer）。认领有异议直接改表推送——看板即事实。

## 契约变更请求（A 机处理，处理完删行）

| 日期 | 请求方 | 内容 | 状态 |
|---|---|---|---|
| 2026-11-09 | B | hub 静态托管 GUI：`GET /gui` → `apps/gui/dist`（静态文件 + index.html 兜底），GUI 生产形态同源免代理（骨架期 dev 走 vite 代理、preview 独立端口已验证） | 待处理 |
| 2026-11-09 | B | ~~AnnouncePayload 迁入 contract~~ | **已处理（A 机）：contract 0.2.0 `discovery.ts`，B 已接线（adapter-direct 现引用契约面）** |

## 决策请求（等用户拍板，拍板后移入 01 文档修订并删行）

| 日期 | 提出方 | 议题 | 状态 |
|---|---|---|---|
| （当前无待决项。历史：#1 自定义 announce 协议——**用户已批准（2026-11-09），已落地 01 §5.1 修订**） | | | |
