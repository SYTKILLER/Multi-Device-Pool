/**
 * MCP 静态基线工具面（01 §4.1）——全 harness 通用，工具表永不增删。
 * per-node 前缀组（动态增强）P1 再加；transfer/handoff 属 P2/P5。
 * 工具描述必须携带 OS/shell/路径形态示例（01 §4.2，防跨平台混淆）。
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const nodeRef = {
  node: { type: 'string', description: '目标节点：display_name 或 node_id（见 nodes() 返回）' },
};

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'nodes',
    description: '列出池内节点：工作区、健康、权限摘要、RTT、未消费 job 计数。调用任何执行类工具前先用它确认节点与工作区名。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'exec',
    description: '在目标节点同步执行命令并返回统一结果信封（status/exit/stdout/stderr）。cwd 首选符号引用 "workspace:<name>"；Windows 节点默认 powershell（UTF-8 已由节点包装）；needs_approval 会转 job；默认超时 120s。',
    inputSchema: {
      type: 'object',
      properties: {
        ...nodeRef,
        cmd: { type: 'string', description: '命令全文' },
        cwd: { type: 'string', description: '如 workspace:repo，或该节点工作区内绝对路径' },
        timeout_ms: { type: 'number', description: '默认 120000，上限 1800000' },
        shell: { type: 'string', description: 'powershell|pwsh|cmd|bash，缺省用节点 manifest 的默认 shell' },
        background: { type: 'boolean', description: 'true 时显式转 job，立即返回 job_id' },
      },
      required: ['node', 'cmd'],
      additionalProperties: false,
    },
  },
  {
    name: 'fs',
    description: '目标节点文件操作。op=read|write|list|glob|grep；path 用 "workspace:<name>/相对路径" 或工作区内绝对路径；写操作受内容闸与 .git/index.lock busy 检测约束。',
    inputSchema: {
      type: 'object',
      properties: {
        ...nodeRef,
        op: { type: 'string', description: 'read|write|list|glob|grep' },
        path: { type: 'string', description: '如 workspace:repo/src/a.ts' },
        content: { type: 'string', description: 'op=write 时的内容' },
        pattern: { type: 'string', description: 'op=grep 的匹配串' },
        glob: { type: 'string', description: 'glob/grep 的文件集，默认 **/*' },
        limit: { type: 'number' },
      },
      required: ['node', 'op', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'job_submit',
    description: '提交后台任务，立即返回 job_id；随后用 job_status/job_output/job_cancel 管理。适合长命令与 needs_approval 转化的任务。',
    inputSchema: {
      type: 'object',
      properties: {
        ...nodeRef,
        cmd: { type: 'string' },
        cwd: { type: 'string' },
        shell: { type: 'string' },
      },
      required: ['node', 'cmd'],
      additionalProperties: false,
    },
  },
  {
    name: 'job_status',
    description: '查询 job 状态（审批 job 与后台 job 通用）。工具描述：先做其他事，间隔 ≥30s 再轮询（01 §6）。',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'job_output',
    description: '分页取回 job 全量输出（output_ref 形如 job:<id>#0；offset/limit 按字符）。',
    inputSchema: {
      type: 'object',
      properties: {
        output_ref: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['output_ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'job_cancel',
    description: '取消 job（后台 job 终止进程；审批 job 等价 deny）。',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'transfer_push',
    description: '（P2）把 hub 宿主机上的本地文件分块推送进目标节点工作区，绕过对话转录（防大载荷损坏）；落地后全量 sha256 校验，返回 TransferOutcome（file_sha256/bytes）。src 为 hub 宿主绝对路径；path 为目标工作区引用，如 workspace:repo/dist/a.bin。上限 256 MiB；节点 agent ≥0.3.0 才可用。',
    inputSchema: {
      type: 'object',
      properties: {
        ...nodeRef,
        src: { type: 'string', description: 'hub 宿主机上的源文件绝对路径' },
        path: { type: 'string', description: '目标引用，如 workspace:repo/dist/a.bin' },
      },
      required: ['node', 'src', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'transfer_fetch',
    description: '（P2）把目标节点工作区里的文件分块取回 hub 宿主机收件箱（<hub-home>/inbox/<transfer_id>/文件名），绕过对话转录；返回 TransferOutcome 含 inbox_path 与 file_sha256。path 为源节点工作区引用，如 workspace:repo/dist/a.bin。上限 256 MiB；节点 agent ≥0.3.0 才可用。',
    inputSchema: {
      type: 'object',
      properties: {
        ...nodeRef,
        path: { type: 'string', description: '源引用，如 workspace:repo/dist/a.bin' },
      },
      required: ['node', 'path'],
      additionalProperties: false,
    },
  },
];
