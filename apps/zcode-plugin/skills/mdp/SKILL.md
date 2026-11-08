---
name: mdp
description: 通过 mdp 工具面操作多设备池——列节点、跨机执行命令与文件操作、长任务与审批。当用户要求"在另一台机器/节点上"做任何事，或提到 pc2 等节点名时使用。
---

# mdp 多设备池工具使用

## 工具面（静态基线，node 参数化）

- `nodes()`：节点列表（在线状态、OS/shell、工作区、权限摘要、未消费 job 计数）。**跨节点操作前先调它**，确认目标节点名与工作区名。
- `exec({node, cmd, cwd, timeout_ms?, shell?, background?})`：在节点上执行命令。cwd 首选 `workspace:<工作区名>`。
- `fs({node, op: read|write|list|glob|grep, path, ...})`：跨节点文件操作；write ≤2MB（更大走 exec 脚本）。
- `job_submit / job_status / job_output / job_cancel`：长任务（>2 分钟或需要后台）一律 job 化，先做别的事再 `job_status`（间隔 ≥30s）。
- `transfer`（P2）/`handoff`（P5）暂不可用。

## 关键语义

1. **节点异构**：先看 `nodes()` 里的 OS/shell——Windows 节点用 PowerShell 语法，别发 `ls`/`grep`（发 `Get-ChildItem`/`Select-String`），路径用反斜杠或 `workspace:` 引用。
2. **错误不盲目重试**：`denied/permission` 永不重试——读 `error.message` 里的原始拒绝原因并改操作；`unknown` 表示结局不明，先用只读命令对账（如"确认 X 是否已存在"）再决定；`offline/busy` 换时机或换节点。
3. **needs_approval**：返回 job_id 后停止等待，告知用户"已提交审批（可在 GUI 处理）"，转做其他事，稍后 `job_status` 轮询。
4. **工作区血统**：`workspace:*` 带迁移标记时注意 warnings 字段——向已移交（superseded）副本写入前先和用户确认。
5. **完全访问节点**：overlay `full_access` 的节点没有内容闸，自我约束是唯一防线——破坏性命令（递归删除/force push/管道执行）务必先向用户复述确认。
