import {
  Activity,
  ArchiveRestore,
  Boxes,
  Cable,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  CloudUpload,
  Command,
  Copy,
  DatabaseBackup,
  FileCode2,
  FolderTree,
  HardDrive,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  Network,
  Pause,
  Play,
  Plus,
  Power,
  RotateCcw,
  ScrollText,
  Server,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  Trash2,
  Users,
  X
} from "lucide-react";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, formatBytes, formatTime } from "./api";
import type { Backup, Dashboard, Instance, InstanceDetail, Node, Schedule, Task, User } from "./types";

type Screen = "overview" | "instances" | "nodes" | "tasks" | "backups" | "audit";
type Modal = "node" | "instance" | null;
type DetailTab = "console" | "files" | "backups" | "schedules";

const nav: Array<{ id: Screen; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "总览", icon: LayoutDashboard },
  { id: "instances", label: "实例", icon: Boxes },
  { id: "nodes", label: "节点", icon: Network },
  { id: "tasks", label: "任务", icon: Activity },
  { id: "backups", label: "备份", icon: DatabaseBackup },
  { id: "audit", label: "审计", icon: ScrollText }
];

const statusText: Record<Instance["status"], string> = {
  creating: "创建中",
  offline: "已停止",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  archived: "已归档",
  error: "异常"
};

const statusClass = (status: Instance["status"] | Task["status"]): string => {
  if (["running", "succeeded"].includes(status)) return "good";
  if (["error", "failed", "cancelled"].includes(status)) return "bad";
  if (["starting", "stopping", "creating", "queued", "delivered", "running"].includes(status)) return "wait";
  return "muted";
};

export function App() {
  const [status, setStatus] = useState<{ setupRequired: boolean; user: User | null }>();
  const refresh = useCallback(async () => {
    try { setStatus(await api<{ setupRequired: boolean; user: User | null }>("/api/auth/status")); } catch { setStatus({ setupRequired: false, user: null }); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  if (!status) return <div className="app-loading"><LoaderCircle size={22} className="spin" /> 正在连接控制面</div>;
  if (status.setupRequired) return <AuthScreen mode="setup" onComplete={refresh} />;
  if (!status.user) return <AuthScreen mode="login" onComplete={refresh} />;
  return <ControlPanel user={status.user} onSignOut={refresh} />;
}

function AuthScreen({ mode, onComplete }: { mode: "setup" | "login"; onComplete: () => Promise<void> }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try {
      await api(`/api/auth/${mode === "setup" ? "bootstrap" : "login"}`, { method: "POST", body: JSON.stringify({ username: data.get("username"), password: data.get("password") }) });
      await onComplete();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法完成登录"); }
    finally { setBusy(false); }
  };
  return <main className="auth-layout">
    <section className="auth-intro">
      <Brand />
      <div className="auth-map" aria-hidden="true"><WorldMap /></div>
      <p className="eyebrow">Minecraft infrastructure control</p>
      <h1>把服务器的每一次变化，放在可见的控制面里。</h1>
      <div className="auth-steps"><span><ShieldCheck size={16} /> 权限与审计</span><span><Cable size={16} /> 节点主动连接</span><span><HardDrive size={16} /> 归档与恢复</span></div>
    </section>
    <section className="auth-form-wrap">
      <form className="auth-form" onSubmit={submit}>
        <p className="eyebrow">{mode === "setup" ? "Initial setup" : "Welcome back"}</p>
        <h2>{mode === "setup" ? "创建首个管理员" : "登录控制面"}</h2>
        <label>用户名<input name="username" autoComplete="username" minLength={3} required placeholder="admin" /></label>
        <label>密码<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={10} required placeholder="至少 10 个字符" /></label>
        {error && <p className="form-error"><CircleAlert size={16} /> {error}</p>}
        <button className="button primary full" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <ChevronRight size={17} />}{mode === "setup" ? "创建并进入面板" : "登录"}</button>
      </form>
    </section>
  </main>;
}

function ControlPanel({ user, onSignOut }: { user: User; onSignOut: () => Promise<void> }) {
  const [screen, setScreen] = useState<Screen>("overview");
  const [panelOpen, setPanelOpen] = useState(false);
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<InstanceDetail>();
  const [modal, setModal] = useState<Modal>(null);
  const [message, setMessage] = useState<string>();
  const [audit, setAudit] = useState<Array<{ id: string; action: string; target: string; detail?: string; createdAt: string }>>([]);

  const refresh = useCallback(async () => {
    try {
      const next = await api<Dashboard>("/api/dashboard");
      setDashboard(next);
      setSelectedId((current) => current && next.instances.some((instance) => instance.id === current) ? current : next.instances[0]?.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法刷新控制面"); }
  }, []);

  const refreshDetail = useCallback(async (instanceId: string) => {
    try { setDetail(await api<InstanceDetail>(`/api/instances/${instanceId}`)); } catch (error) { setMessage(error instanceof Error ? error.message : "无法加载实例"); }
  }, []);

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => { if (selectedId) void refreshDetail(selectedId); else setDetail(undefined); }, [selectedId, refreshDetail]);
  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws/ui`);
    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { type: string; instanceId?: string; line?: string };
      if (payload.type === "console.output" && payload.instanceId === selectedId && payload.line) {
        setDetail((current) => current ? { ...current, console: [...current.console.slice(-499), payload.line!] } : current);
      } else void refresh();
    };
    return () => socket.close();
  }, [refresh, selectedId]);

  const selected = dashboard?.instances.find((instance) => instance.id === selectedId);
  const action = async (instance: Instance, name: "start" | "stop" | "restart" | "kill", command?: string) => {
    if (name === "kill" && !window.confirm(`强制停止 ${instance.name}？未保存的数据可能丢失。`)) return;
    try {
      await api(`/api/instances/${instance.id}/actions`, { method: "POST", body: JSON.stringify({ action: name, command }) });
      setMessage(`${instance.name}：任务已提交`); void refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "操作未完成"); }
  };
  const signOut = async () => { await api("/api/auth/logout", { method: "POST" }); await onSignOut(); };
  const loadAudit = async () => { try { setAudit((await api<{ audits: typeof audit }>("/api/audit")).audits); } catch (error) { setMessage(error instanceof Error ? error.message : "无法读取审计记录"); } };
  useEffect(() => { if (screen === "audit" && user.role === "admin") void loadAudit(); }, [screen, user.role]);

  return <div className="shell">
    <aside className={`sidebar ${panelOpen ? "open" : ""}`}>
      <div className="sidebar-brand"><Brand compact /><button className="icon-button close-nav" title="收起导航" onClick={() => setPanelOpen(false)}><X size={19} /></button></div>
      <nav>{nav.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${screen === id ? "active" : ""}`} onClick={() => { setScreen(id); setPanelOpen(false); }}><Icon size={18} /><span>{label}</span>{id === "tasks" && dashboard && dashboard.summary.queuedTasks > 0 && <i>{dashboard.summary.queuedTasks}</i>}</button>)}</nav>
      <div className="sidebar-footer"><div className="user-chip"><div>{user.username.slice(0, 1).toUpperCase()}</div><span><strong>{user.username}</strong><small>{user.role === "admin" ? "管理员" : "协作者"}</small></span></div><button className="icon-button" title="退出登录" onClick={() => void signOut()}><LogOut size={18} /></button></div>
    </aside>
    {panelOpen && <button className="nav-scrim" aria-label="关闭导航" onClick={() => setPanelOpen(false)} />}
    <main className="workspace">
      <header className="topbar"><button className="icon-button mobile-menu" title="打开导航" onClick={() => setPanelOpen(true)}><Menu size={20} /></button><div><p className="eyebrow">Control plane</p><h2>{nav.find((item) => item.id === screen)?.label}</h2></div><div className="topbar-actions"><span className="connection"><i /> {dashboard?.summary.onlineNodes ?? 0}/{dashboard?.summary.totalNodes ?? 0} 节点在线</span>{user.role === "admin" && <button className="button primary" onClick={() => setModal(screen === "nodes" ? "node" : "instance")}><Plus size={17} />{screen === "nodes" ? "添加节点" : "创建实例"}</button>}</div></header>
      {!dashboard ? <div className="page-loading"><LoaderCircle className="spin" size={22} /> 正在载入运行状态</div> : <section className="page-content">
        {screen === "overview" && <Overview dashboard={dashboard} selected={selected} onSelect={(instance) => { setSelectedId(instance.id); setScreen("instances"); }} onNew={() => setModal("instance")} />}
        {screen === "instances" && <Instances dashboard={dashboard} selectedId={selectedId} onSelect={setSelectedId} onNew={() => setModal("instance")} />}
        {screen === "nodes" && <Nodes nodes={dashboard.nodes} onNew={() => setModal("node")} />}
        {screen === "tasks" && <Tasks tasks={dashboard.tasks} instances={dashboard.instances} />}
        {screen === "backups" && <Backups backups={dashboard.backups} instances={dashboard.instances} />}
        {screen === "audit" && <Audit events={audit} allow={user.role === "admin"} />}
        {screen === "instances" && selected && <InstanceWorkspace key={selected.id} detail={detail} instance={selected} onAction={action} notify={setMessage} reload={() => { void refresh(); void refreshDetail(selected.id); }} />}
      </section>}
    </main>
    {modal === "node" && <NodeModal onClose={() => setModal(null)} refresh={refresh} notify={setMessage} />}
    {modal === "instance" && dashboard && <InstanceModal nodes={dashboard.nodes} onClose={() => setModal(null)} refresh={refresh} notify={setMessage} />}
    {message && <button className="toast" onClick={() => setMessage(undefined)}><Check size={16} />{message}<X size={15} /></button>}
  </div>;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><div className="brand-mark" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>{!compact && <span>MicoPanel<small>CONTROL</small></span>}</div>;
}

function WorldMap() { return <div className="world-map">{Array.from({ length: 36 }, (_, index) => <i key={index} className={[3, 4, 9, 10, 11, 16, 17, 18, 20, 21, 22, 27, 28, 29, 32].includes(index) ? "land" : index % 7 === 0 ? "node" : ""} />)}</div>; }

function Overview({ dashboard, selected, onSelect, onNew }: { dashboard: Dashboard; selected?: Instance; onSelect: (instance: Instance) => void; onNew: () => void }) {
  return <>
    <section className="metrics-grid">
      <Metric label="运行实例" value={`${dashboard.summary.runningInstances}`} suffix={`/ ${dashboard.summary.totalInstances}`} icon={<Power size={19} />} tone="mint" />
      <Metric label="在线节点" value={`${dashboard.summary.onlineNodes}`} suffix={`/ ${dashboard.summary.totalNodes}`} icon={<Network size={19} />} tone="forest" />
      <Metric label="待执行任务" value={String(dashboard.summary.queuedTasks)} icon={<Clock3 size={19} />} tone="amber" />
      <Metric label="最近备份" value={dashboard.backups.filter((backup) => backup.status === "available").length ? formatTime(dashboard.backups.find((backup) => backup.status === "available")?.createdAt) : "暂无"} icon={<DatabaseBackup size={19} />} tone="stone" />
    </section>
    <section className="overview-grid">
      <section className="panel instance-panel"><div className="panel-heading"><div><p className="eyebrow">Workloads</p><h3>实例运行态</h3></div><button className="icon-button" title="创建实例" onClick={onNew}><Plus size={19} /></button></div>{dashboard.instances.length ? <InstanceTable instances={dashboard.instances.filter((instance) => instance.status !== "archived").slice(0, 7)} selectedId={selected?.id} onSelect={onSelect} /> : <Empty icon={<Server size={24} />} title="还没有实例" action="创建实例" onAction={onNew} />}</section>
      <section className="panel capacity-panel"><div className="panel-heading"><div><p className="eyebrow">Node fabric</p><h3>节点容量</h3></div><span className="legend"><i /> 在线</span></div><div className="node-fabric"><WorldMap /><div className="fabric-list">{dashboard.nodes.length ? dashboard.nodes.map((node) => <div key={node.id} className="fabric-row"><span className={`dot ${node.online ? "online" : ""}`} /><strong>{node.name}</strong><small>{node.online ? "已连接" : "等待 Agent"}</small></div>) : <p>添加节点后会在这里显示容量和连接状态。</p>}</div></div></section>
    </section>
    <section className="panel task-strip"><div className="panel-heading"><div><p className="eyebrow">Activity</p><h3>最近任务</h3></div></div>{dashboard.tasks.length ? <Tasks tasks={dashboard.tasks.slice(0, 5)} instances={dashboard.instances} compact /> : <p className="quiet">新任务会在这里显示执行状态。</p>}</section>
  </>;
}

function Metric({ label, value, suffix, icon, tone }: { label: string; value: string; suffix?: string; icon: ReactNode; tone: string }) { return <section className={`metric ${tone}`}><span className="metric-icon">{icon}</span><p>{label}</p><strong>{value}<small>{suffix}</small></strong></section>; }

function Instances({ dashboard, selectedId, onSelect, onNew }: { dashboard: Dashboard; selectedId?: string; onSelect: (id: string) => void; onNew: () => void }) {
  const [filter, setFilter] = useState("all");
  const visible = dashboard.instances.filter((instance) => filter === "all" || instance.status === filter);
  return <section className="panel table-panel"><div className="panel-heading table-heading"><div><p className="eyebrow">Workloads</p><h3>全部实例</h3></div><div className="filters"><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>全部</button><button className={filter === "running" ? "selected" : ""} onClick={() => setFilter("running")}>运行中</button><button className={filter === "offline" ? "selected" : ""} onClick={() => setFilter("offline")}>已停止</button><button className={filter === "error" ? "selected" : ""} onClick={() => setFilter("error")}>异常</button><button className="button compact primary" onClick={onNew}><Plus size={16} />创建</button></div></div>{visible.length ? <InstanceTable instances={visible} selectedId={selectedId} onSelect={(instance) => onSelect(instance.id)} /> : <Empty icon={<Boxes size={24} />} title="没有符合条件的实例" action="创建实例" onAction={onNew} />}</section>;
}

function InstanceTable({ instances, selectedId, onSelect }: { instances: Instance[]; selectedId?: string; onSelect: (instance: Instance) => void }) { return <div className="instance-table"><div className="table-row table-head"><span>实例</span><span>版本 / 类型</span><span>资源上限</span><span>端口</span><span>状态</span><span /></div>{instances.map((instance) => <button key={instance.id} className={`table-row instance-row ${selectedId === instance.id ? "selected" : ""}`} onClick={() => onSelect(instance)}><span className="instance-name"><b>{instance.name.slice(0, 2).toUpperCase()}</b><strong>{instance.name}<small>{instance.kind}</small></strong></span><span>{instance.version}<small>{instance.image.split(":")[0]}</small></span><span>{instance.limits.memoryMb >= 1024 ? `${(instance.limits.memoryMb / 1024).toFixed(0)} GB` : `${instance.limits.memoryMb} MB`}<small>{instance.limits.cpuCores} vCPU</small></span><span>{instance.ports.map((port) => `${port.host}/${port.protocol}`).join(", ")}</span><span><Status value={statusText[instance.status]} status={instance.status} /></span><span><ChevronRight size={17} /></span></button>)}</div>; }

function Nodes({ nodes, onNew }: { nodes: Node[]; onNew: () => void }) { return <section className="panel nodes-panel"><div className="panel-heading"><div><p className="eyebrow">Compute fabric</p><h3>受管节点</h3></div><button className="button primary" onClick={onNew}><Plus size={17} />添加节点</button></div>{nodes.length ? <div className="node-list">{nodes.map((node) => <article className="node-card" key={node.id}><div className="node-card-top"><span className={`dot large ${node.online ? "online" : ""}`} /><div><h4>{node.name}</h4><p>{node.online ? "Agent 已连接" : "等待 Agent 注册"}</p></div><Status value={node.online ? "在线" : "离线"} status={node.online ? "running" : "offline"} /></div><div className="node-stats"><span><Server size={15} />{node.agentVersion ?? "未登记"}</span><span><Cable size={15} />{node.portRangeStart} - {node.portRangeEnd}</span><span><HardDrive size={15} />{formatBytes(node.usage?.diskBytes)}</span></div><div className="util-bar"><i style={{ width: `${Math.min(100, node.usage?.cpuPercent ?? 0)}%` }} /></div></article>)}</div> : <Empty icon={<Network size={25} />} title="还没有受管节点" action="添加节点" onAction={onNew} />}</section>; }

function Tasks({ tasks, instances, compact = false }: { tasks: Task[]; instances: Instance[]; compact?: boolean }) { return <div className={`tasks-list ${compact ? "compact" : ""}`}>{tasks.map((task) => <div className="task-row" key={task.id}><span className={`task-symbol ${statusClass(task.status)}`}><Command size={15} /></span><span><strong>{task.type.replace("instance.", "")}</strong><small>{instances.find((instance) => instance.id === task.instanceId)?.name ?? "节点任务"}</small></span><span className="task-message">{task.message ?? "等待节点接收"}</span><Status value={task.status === "succeeded" ? "完成" : task.status === "failed" ? "失败" : task.status === "running" ? "执行中" : "排队中"} status={task.status} /></div>)}</div>; }

function Backups({ backups, instances }: { backups: Backup[]; instances: Instance[] }) { return <section className="panel table-panel"><div className="panel-heading"><div><p className="eyebrow">Restore points</p><h3>备份归档</h3></div></div>{backups.length ? <div className="backup-list">{backups.map((backup) => <div className="backup-row" key={backup.id}><DatabaseBackup size={19} /><span><strong>{backup.name}</strong><small>{instances.find((instance) => instance.id === backup.instanceId)?.name ?? "已删除实例"} · {formatTime(backup.createdAt)}</small></span><span>{backup.destination === "s3" ? "S3 / MinIO" : "节点本地"}<small>{formatBytes(backup.sizeBytes)}</small></span><Status value={backup.status === "available" ? "可用" : backup.status === "failed" ? "失败" : "处理中"} status={backup.status === "available" ? "succeeded" : backup.status === "failed" ? "failed" : "running"} /></div>)}</div> : <Empty icon={<DatabaseBackup size={24} />} title="还没有备份归档" />}</section>; }

function Audit({ events, allow }: { events: Array<{ id: string; action: string; target: string; detail?: string; createdAt: string }>; allow: boolean }) { if (!allow) return <section className="panel"><Empty icon={<ShieldCheck size={24} />} title="审计记录仅向管理员开放" /></section>; return <section className="panel table-panel"><div className="panel-heading"><div><p className="eyebrow">Security trail</p><h3>操作审计</h3></div></div>{events.length ? <div className="audit-list">{events.map((event) => <div className="audit-row" key={event.id}><ShieldCheck size={17} /><span><strong>{event.action}</strong><small>{event.target}{event.detail ? ` · ${event.detail}` : ""}</small></span><time>{formatTime(event.createdAt)}</time></div>)}</div> : <p className="quiet">尚未记录控制面操作。</p>}</section>; }

function InstanceWorkspace({ detail, instance, onAction, notify, reload }: { detail?: InstanceDetail; instance: Instance; onAction: (instance: Instance, action: "start" | "stop" | "restart" | "kill", command?: string) => Promise<void>; notify: (message?: string) => void; reload: () => void }) {
  const [tab, setTab] = useState<DetailTab>("console");
  const [command, setCommand] = useState("");
  const [files, setFiles] = useState<Array<{ path: string; content?: string; size: number; modifiedAt: string }>>([]);
  const [scheduleName, setScheduleName] = useState("");
  const [cron, setCron] = useState("0 4 * * *");
  useEffect(() => { setTab("console"); }, [instance.id]);
  useEffect(() => { setFiles(detail?.files ?? []); }, [detail]);
  const sendCommand = async (event: FormEvent) => { event.preventDefault(); if (!command.trim()) return; await onAction(instance, "command" as never, command); setCommand(""); };
  const loadFiles = async () => { try { await api(`/api/instances/${instance.id}/files/sync`, { method: "POST" }); setFiles((await api<{ files: typeof files }>(`/api/instances/${instance.id}/files`)).files); notify("文件同步任务已提交"); } catch (error) { notify(error instanceof Error ? error.message : "无法读取文件"); } };
  const backup = async () => { try { await api(`/api/instances/${instance.id}/backups`, { method: "POST", body: JSON.stringify({ destination: "local" }) }); notify("备份任务已提交"); reload(); } catch (error) { notify(error instanceof Error ? error.message : "备份任务未完成"); } };
  const addSchedule = async (event: FormEvent) => { event.preventDefault(); try { await api(`/api/instances/${instance.id}/schedules`, { method: "POST", body: JSON.stringify({ name: scheduleName, cron, action: "backup", payload: {} }) }); setScheduleName(""); notify("计划任务已创建"); reload(); } catch (error) { notify(error instanceof Error ? error.message : "计划任务未创建"); } };
  return <section className="instance-workspace"><div className="worktop"><div><span className="back-label">正在管理</span><h3>{instance.name}<Status value={statusText[instance.status]} status={instance.status} /></h3><p>{instance.kind} · {instance.version} · {instance.ports.map((port) => `${port.host}/${port.protocol}`).join(", ")}</p></div><div className="power-controls"><button className="icon-button action-good" title="启动" disabled={instance.status === "running" || instance.status === "starting"} onClick={() => void onAction(instance, "start")}><Play size={17} /></button><button className="icon-button" title="重启" onClick={() => void onAction(instance, "restart")}><RotateCcw size={17} /></button><button className="icon-button action-warn" title="停止" disabled={instance.status === "offline"} onClick={() => void onAction(instance, "stop")}><Pause size={17} /></button><button className="icon-button action-bad" title="强制停止" onClick={() => void onAction(instance, "kill")}><Power size={17} /></button></div></div><div className="detail-tabs">{(["console", "files", "backups", "schedules"] as DetailTab[]).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => { setTab(item); if (item === "files") void loadFiles(); }}>{item === "console" ? "控制台" : item === "files" ? "文件" : item === "backups" ? "备份" : "计划任务"}</button>)}</div>{tab === "console" && <div className="console-tool"><div className="console-head"><span><Terminal size={15} /> 实时控制台</span><span>{detail?.console.length ?? 0} 行</span></div><pre>{detail?.console.length ? detail.console.join("\n") : "等待节点输出..."}</pre><form onSubmit={sendCommand} className="command-line"><span>&gt;</span><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="输入服务器命令" /><button className="icon-button" title="发送命令" type="submit"><ChevronRight size={18} /></button></form></div>}{tab === "files" && <div className="file-tool"><div className="tool-title"><FolderTree size={18} /> 文件目录 <button className="icon-button" title="刷新文件" onClick={() => void loadFiles()}><RotateCcw size={16} /></button></div>{files.length ? files.map((file) => <article key={file.path}><FileCode2 size={17} /><span><strong>{file.path}</strong><small>{file.size} B</small></span></article>) : <p className="quiet">节点文件将在首次读取后显示。</p>}</div>}{tab === "backups" && <div className="backup-tool"><button className="button primary" onClick={() => void backup()}><DatabaseBackup size={17} />创建备份</button>{detail?.backups.length ? <Backups backups={detail.backups} instances={[instance]} /> : <p className="quiet">创建备份后可在此查看归档状态。</p>}</div>}{tab === "schedules" && <div className="schedule-tool"><form onSubmit={addSchedule}><label>任务名称<input value={scheduleName} required onChange={(event) => setScheduleName(event.target.value)} placeholder="每日备份" /></label><label>Cron<input value={cron} required onChange={(event) => setCron(event.target.value)} /></label><button className="button primary"><Plus size={16} />添加备份计划</button></form>{detail?.schedules.length ? detail.schedules.map((schedule: Schedule) => <div className="schedule-row" key={schedule.id}><Clock3 size={17} /><span><strong>{schedule.name}</strong><small>{schedule.cron} · 下次 {formatTime(schedule.nextRunAt)}</small></span><Status value={schedule.enabled ? "已启用" : "暂停"} status={schedule.enabled ? "running" : "offline"} /></div>) : <p className="quiet">还没有计划任务。</p>}</div>}</section>;
}

function NodeModal({ onClose, refresh, notify }: { onClose: () => void; refresh: () => Promise<void>; notify: (message?: string) => void }) {
  const [token, setToken] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); try { const response = await api<{ enrollmentToken: string }>("/api/nodes", { method: "POST", body: JSON.stringify({ name: data.get("name"), portRangeStart: Number(data.get("start")), portRangeEnd: Number(data.get("end")) }) }); setToken(response.enrollmentToken); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "节点未创建"); } finally { setBusy(false); } };
  return <Dialog title="添加受管节点" onClose={onClose}>{token ? <div className="enrollment"><ShieldCheck size={28} /><p>仅显示一次的注册令牌</p><code>{token}</code><button className="button" onClick={() => void navigator.clipboard.writeText(token)}><Copy size={16} />复制令牌</button><pre>{`CONTROLLER_URL=${location.origin}\nENROLLMENT_TOKEN=${token}`}</pre></div> : <form className="dialog-form" onSubmit={submit}><label>节点名称<input name="name" required placeholder="杭州-01" /></label><div className="two-inputs"><label>起始端口<input name="start" type="number" defaultValue="25565" min="1024" /></label><label>结束端口<input name="end" type="number" defaultValue="25665" min="1025" /></label></div><button className="button primary" disabled={busy}>{busy && <LoaderCircle size={16} className="spin" />}生成注册令牌</button></form>}</Dialog>;
}

function InstanceModal({ nodes, onClose, refresh, notify }: { nodes: Node[]; onClose: () => void; refresh: () => Promise<void>; notify: (message?: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState("paper");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      let artifactId: string | undefined;
      if (kind === "custom") {
        const file = data.get("artifact");
        if (!(file instanceof File) || file.size === 0) throw new Error("请选择 JAR 或 ZIP 服务端包");
        const upload = new FormData();
        upload.append("file", file);
        const result = await api<{ artifact: { id: string } }>("/api/artifacts", { method: "POST", body: upload });
        artifactId = result.artifact.id;
      }
      await api("/api/instances", { method: "POST", body: JSON.stringify({ name: data.get("name"), nodeId: data.get("nodeId"), kind, version: data.get("version"), memoryMb: Number(data.get("memory")), cpuCores: Number(data.get("cpu")), diskMb: Number(data.get("disk")), pids: 512, artifactId, customJar: data.get("customJar") || undefined, eulaAccepted: data.get("eula") === "on" }) });
      await refresh(); onClose(); notify("实例创建任务已提交");
    } catch (error) { notify(error instanceof Error ? error.message : "实例未创建"); }
    finally { setBusy(false); }
  };
  return <Dialog title="创建 Minecraft 实例" onClose={onClose}>{nodes.length ? <form className="dialog-form" onSubmit={submit}>
    <label>实例名称<input name="name" required placeholder="survival-01" /></label>
    <div className="two-inputs"><label>节点<select name="nodeId" required>{nodes.map((node) => <option value={node.id} key={node.id}>{node.name}{node.online ? "" : "（离线，任务将排队）"}</option>)}</select></label><label>服务端<select name="kind" value={kind} onChange={(event) => setKind(event.target.value)}><option value="paper">Paper</option><option value="vanilla">Vanilla Java</option><option value="fabric">Fabric</option><option value="forge">Forge</option><option value="bedrock">Bedrock</option><option value="custom">自定义包</option></select></label></div>
    {kind === "custom" && <><label>服务端包<input name="artifact" type="file" accept=".jar,.zip,application/java-archive,application/zip" required /></label><label>入口 JAR<input name="customJar" placeholder="ZIP 包默认使用 server.jar" /></label></>}
    <div className="two-inputs"><label>版本<input name="version" defaultValue="1.21.4" required /></label><label>内存 MB<input name="memory" type="number" defaultValue="2048" min="512" /></label></div>
    <div className="two-inputs"><label>vCPU<input name="cpu" type="number" step="0.25" defaultValue="1" min="0.25" /></label><label>磁盘 MB<input name="disk" type="number" defaultValue="10240" min="1024" /></label></div>
    <label className="check-row"><input name="eula" type="checkbox" required />我已阅读并同意 Mojang EULA</label><button className="button primary" disabled={busy}>{busy && <LoaderCircle size={16} className="spin" />}创建实例</button>
  </form> : <Empty icon={<Network size={24} />} title="请先添加节点" />}</Dialog>;
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) { return <div className="modal-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-label={title}><div className="dialog-head"><h3>{title}</h3><button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></div>{children}</section></div>; }
function Status({ value, status }: { value: string; status: Instance["status"] | Task["status"] }) { return <span className={`status ${statusClass(status)}`}><i />{value}</span>; }
function Empty({ icon, title, action, onAction }: { icon: ReactNode; title: string; action?: string; onAction?: () => void }) { return <div className="empty"><span>{icon}</span><p>{title}</p>{action && <button className="button compact" onClick={onAction}>{action}</button>}</div>; }
