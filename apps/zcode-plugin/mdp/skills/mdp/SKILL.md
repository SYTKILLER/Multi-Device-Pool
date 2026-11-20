---
name: mdp
description: 通过 mdp 工具面操作多设备池——列节点、跨机执行命令与文件操作、长任务与审批。当用户要求"在另一台机器/节点上"做任何事，或提到 pc2 等节点名时使用。
---

# mdp 多设备池工具使用

## 工具面（静态基线，node 参数化）

- `nodes()`：节点列表（在线状态、OS/shell、工作区、权限摘要、未消费 job 计数）。**跨节点操作前先调它**，确认目标节点名与工作区名。
- `exec({node, cmd, cwd, timeout_ms?, shell?, background?})`：在节点上执行命令。cwd 首选 `workspace:<工作区名>`。
- `fs({node, op: read|write|list|glob|grep, path, ...})`：跨节点文件操作；write ≤2MB（更大走 transfer）。
- `job_submit / job_status / job_output / job_cancel`：长任务（>2 分钟或需要后台）一律 job 化，先做别的事再 `job_status`（间隔 ≥30s）。
- `transfer_push({node, src, path})`：把 **hub 宿主机**上的本地文件分块推入节点工作区（上限 256 MiB，二进制通道——大载荷/中文/二进制一律走它，杜绝对话转录损坏；src 必须是 hub 宿主绝对路径）。
- `transfer_fetch({node, path, migrate?})`：把节点工作区文件取回 hub 宿主收件箱（返回 inbox_path + file_sha256，双侧比对）。`migrate:true` = 搬迁声明：成功后源节点该工作区副本标 superseded（节点间搬迁 = fetch(migrate) 搬出 + push 落目标 组合）。
- `workspace_unsupersede({node, workspace})`：人工/GUI 确认副本仍权威后清除 superseded 标记。
- `handoff`（P5）暂不可用。

## 关键语义

1. **节点异构**：先看 `nodes()` 里的 OS/shell——Windows 节点用 PowerShell 语法，别发 `ls`/`grep`（发 `Get-ChildItem`/`Select-String`），路径用反斜杠或 `workspace:` 引用。
2. **错误不盲目重试**：`denied/permission` 永不重试——读 `error.message` 里的原始拒绝原因并改操作；`unknown` 表示结局不明，先用只读命令对账（如"确认 X 是否已存在"）再决定；`offline/busy` 换时机或换节点。
3. **needs_approval**：返回 job_id 后停止等待，告知用户"已提交审批（可在 GUI 处理）"，转做其他事，稍后 `job_status` 轮询。
4. **工作区血统**：节点机侧文件入池用 CLI `mdp file stash`（不经对话）；信封带 `warnings`（如 superseded 强警告）= 非致命提示，**先读再决定**——向已让位（superseded）副本写入会造成分支，确认前先和用户对齐或 `workspace_unsupersede` 清标记。
5. **完全访问节点**：overlay `full_access` 的节点没有内容闸，自我约束是唯一防线——破坏性命令（递归删除/force push/管道执行）务必先向用户复述确认。
