/** hub REST 客户端（P1-8 骨架）：Bearer token（红队 P0-3），base 可配（dev 走 /mdp-api 代理，生产同源） */

export interface NodeSnapshot {
  node_id: string;
  display_name: string;
  online: boolean;
  os?: string;
  arch?: string;
  agent_version?: string;
  shell?: string;
  native_enforcement?: string;
  workspaces?: Array<{ name: string; path: string; revision: number; superseded: boolean }>;
  version_warning?: string;
  rtt_ms?: number;
  last_seen?: string;
}

export interface HubJob {
  job_id: string;
  node_id: string;
  kind: string;
  state: string;
  cmd: string;
  created_at: string;
  ttl_ms: number;
}

export interface OverlayConfig {
  mode: 'standard' | 'full_access';
  enabled: boolean;
  levels: { fs: string; exec: string; transfer: string };
  path_domains: string[];
  content_gate: 'approval' | 'off';
  command_patterns_allow: string[];
  epoch: number;
}

export class MdpApi {
  constructor(private base: string, private token: string) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}`, ...(init?.headers ?? {}) },
    });
    if (res.status === 401) throw new Error('401：令牌无效（mdp hub token 查看后重新粘贴）');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status}：${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  health = () => this.call<{ ok: boolean; uptime_s: number }>('/healthz');
  nodes = () => this.call<{ nodes: NodeSnapshot[] }>('/nodes');
  jobs = () => this.call<{ jobs: HubJob[] }>('/jobs');
  overlay = (nodeId: string) => this.call<{ node_id: string; overlay: OverlayConfig }>(`/nodes/${nodeId}/overlay`);
  patchOverlay = (nodeId: string, patch: Partial<OverlayConfig>) =>
    this.call<{ ok: boolean; overlay: OverlayConfig }>(`/nodes/${nodeId}/overlay`, { method: 'PATCH', body: JSON.stringify(patch) });
  approve = (jobId: string, remember?: boolean, prefix?: string) =>
    this.call<{ ok: boolean; state?: string }>(`/jobs/${jobId}/approve`, { method: 'POST', body: JSON.stringify({ remember, prefix }) });
  deny = (jobId: string) =>
    this.call<{ ok: boolean; state?: string }>(`/jobs/${jobId}/deny`, { method: 'POST', body: JSON.stringify({}) });
}
