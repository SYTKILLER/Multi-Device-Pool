import { useCallback, useEffect, useMemo, useState } from 'react';
import { MdpApi, type HubJob, type NodeSnapshot, type OverlayConfig } from './api.js';

type Tab = 'nodes' | 'approvals' | 'jobs' | 'overlay';

const load = (k: string, d: string): string => localStorage.getItem(k) ?? d;
const fmtLeft = (createdAt: string, ttlMs: number): string => {
  const left = new Date(createdAt).getTime() + ttlMs - Date.now();
  if (left <= 0) return '已过期';
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  return `剩余 ${m}分${s.toString().padStart(2, '0')}秒`;
};

function NodeCard({ n }: { n: NodeSnapshot }) {
  return (
    <div className="card">
      <div className="row">
        <span className="dot" data-online={n.online} />
        <b>{n.display_name}</b>
        <span className="dim">{n.node_id}</span>
        {n.version_warning && <span className="warn">⚠ {n.version_warning}</span>}
      </div>
      <div className="row dim">
        {n.os ?? '?'} · {n.arch ?? '?'} · agent {n.agent_version ?? '?'} · shell {n.shell ?? '?'} · 强制={n.native_enforcement ?? '?'}
        {typeof n.rtt_ms === 'number' ? ` · RTT ${n.rtt_ms}ms` : ''}
      </div>
      <div className="row dim">
        工作区：{(n.workspaces ?? []).map((w) => `${w.name}${w.superseded ? '（已移交）' : ''}`).join('、') || '—'}
      </div>
    </div>
  );
}

function ApprovalCard({ job, api, onChanged }: { job: HubJob; api: MdpApi; onChanged: () => void }) {
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const act = async (kind: 'approve' | 'deny') => {
    setBusy(true); setErr('');
    try {
      if (kind === 'approve') await api.approve(job.job_id, remember);
      else await api.deny(job.job_id);
      onChanged();
    } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); }
  };
  return (
    <div className="card approval">
      <div className="row"><b>审批</b><span className="ttl">{fmtLeft(job.created_at, job.ttl_ms)}</span></div>
      <div className="cmd">{job.cmd}</div>
      <div className="row dim">节点 {job.node_id} · {job.kind} · job {job.job_id}</div>
      <div className="row">
        <label><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> 记住命令前缀（学习式白名单，P1-2）</label>
        <button disabled={busy} onClick={() => act('approve')}>批准</button>
        <button disabled={busy} className="danger" onClick={() => act('deny')}>拒绝</button>
        {err && <span className="warn">{err}</span>}
      </div>
    </div>
  );
}

function OverlayPanel({ api, nodes }: { api: MdpApi; nodes: NodeSnapshot[] }) {
  const [nodeId, setNodeId] = useState(nodes[0]?.node_id ?? '');
  const [ov, setOv] = useState<OverlayConfig | null>(null);
  const [msg, setMsg] = useState('');
  const reload = useCallback(() => {
    if (!nodeId) return;
    api.overlay(nodeId).then((r) => setOv(r.overlay)).catch((e) => setMsg(String(e.message)));
  }, [api, nodeId]);
  useEffect(reload, [reload]);
  if (nodes.length === 0) return <p className="dim">池内暂无节点。</p>;
  const patch = async (p: Partial<OverlayConfig>) => {
    if (!nodeId) return;
    try { const r = await api.patchOverlay(nodeId, p); setOv(r.overlay); setMsg('已下发并推送'); }
    catch (e) { setMsg(String((e as Error).message)); }
  };
  return (
    <div>
      <div className="row">
        节点：<select value={nodeId} onChange={(e) => { setMsg(''); setNodeId(e.target.value); }}>
          {nodes.map((n) => <option key={n.node_id} value={n.node_id}>{n.display_name}</option>)}
        </select>
        {msg && <span className="dim">{msg}</span>}
      </div>
      {ov && (
        <div className="card">
          <div className="row">
            <b>overlay（epoch {ov.epoch}）</b>
            <span className={ov.mode === 'full_access' ? 'warn' : 'dim'}>{ov.mode === 'full_access' ? '⚠ 完全访问：内容闸关闭' : 'standard'}</span>
          </div>
          <div className="row">
            等级 fs/​exec/transfer：{ov.levels.fs} / {ov.levels.exec} / {ov.levels.transfer}
            <button onClick={() => patch({ levels: { ...ov.levels, exec: ov.levels.exec === 'workspaces' ? 'allowlist' : 'workspaces' } })}>切换 exec 等级</button>
          </div>
          <div className="row dim">路径域：{ov.path_domains.join('、') || '—'}</div>
          <div className="row dim">白名单前缀：{ov.command_patterns_allow.join('、') || '—'}</div>
          <div className="row">
            <button className="danger" onClick={() => patch({ mode: ov.mode === 'standard' ? 'full_access' : 'standard' })}>
              {ov.mode === 'standard' ? '切换为完全访问（内容闸关闭）' : '恢复 standard（内容闸开启）'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [base, setBase] = useState(load('mdp-base', ''));
  const [token, setToken] = useState(load('mdp-token', ''));
  const [connected, setConnected] = useState<'no' | 'yes' | 'bad'>('no');
  const [tab, setTab] = useState<Tab>('nodes');
  const [nodes, setNodes] = useState<NodeSnapshot[]>([]);
  const [jobs, setJobs] = useState<HubJob[]>([]);
  const [tick, setTick] = useState(0);

  const effBase = base.trim() === '' ? '/mdp-api' : base.trim().replace(/\/$/, '');
  const api = useMemo(() => new MdpApi(effBase, token), [effBase, token]);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [ns, js] = await Promise.all([api.nodes(), api.jobs()]);
      setNodes(ns.nodes ?? []);
      setJobs(js.jobs ?? []);
      setConnected('yes');
    } catch { setConnected('bad'); }
  }, [api, token]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); setTick((x) => x + 1); }, 2000);
    return () => clearInterval(t);
  }, [refresh]);
  void tick; // 触发审批卡倒计时重渲

  if (!token) {
    return (
      <div className="wrap">
        <h1>mdp · 设备池管理面</h1>
        <div className="card">
          <p>首次访问：粘贴管理令牌（主机上运行 <code>mdp hub token</code> 查看，或读 <code>~/.mdp/hub-info.json</code>）。</p>
          <div className="row">
            hub 地址（留空=同源代理）：<input value={base} onChange={(e) => setBase(e.target.value)} placeholder="/mdp-api 或 http://127.0.0.1:7800" />
          </div>
          <div className="row">
            管理令牌：<input value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <button onClick={() => { localStorage.setItem('mdp-token', token); localStorage.setItem('mdp-base', base); setToken(token); }}>进入</button>
        </div>
      </div>
    );
  }

  const pending = jobs.filter((j) => j.state === 'needs_approval');
  return (
    <div className="wrap">
      <h1>mdp · 设备池管理面 <span className={'conn ' + connected}>{connected === 'yes' ? '已连接' : connected === 'bad' ? '连接失败/令牌无效' : '连接中'}</span></h1>
      <div className="tabs">
        {(['nodes', 'approvals', 'jobs', 'overlay'] as Tab[]).map((t) => (
          <button key={t} data-active={tab === t} onClick={() => setTab(t)}>
            {{ nodes: `节点（${nodes.length}）`, approvals: `审批（${pending.length}）`, jobs: `任务（${jobs.length}）`, overlay: 'Overlay' }[t]}
          </button>
        ))}
        <span className="spacer" />
        <button className="link" onClick={() => { localStorage.removeItem('mdp-token'); setToken(''); }}>换令牌</button>
      </div>
      {tab === 'nodes' && nodes.map((n) => <NodeCard key={n.node_id} n={n} />)}
      {tab === 'approvals' && (pending.length === 0 ? <p className="dim">暂无待审批项。</p> : pending.map((j) => <ApprovalCard key={j.job_id} job={j} api={api} onChanged={() => void refresh()} />))}
      {tab === 'jobs' && (
        <div className="card">
          {jobs.length === 0 && <p className="dim">暂无任务记录。</p>}
          {jobs.map((j) => (
            <div key={j.job_id} className="row">
              <span className="dot" data-online={j.state === 'finished' || j.state === 'running'} />
              <code>{j.job_id}</code> {j.state} · {j.kind} @ {j.node_id} · <span className="cmd inline">{j.cmd.slice(0, 80)}</span>
            </div>
          ))}
        </div>
      )}
      {tab === 'overlay' && <OverlayPanel api={api} nodes={nodes} />}
    </div>
  );
}
