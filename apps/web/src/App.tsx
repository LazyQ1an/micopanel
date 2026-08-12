import {
  Activity,
  ArchiveRestore,
  Boxes,
  Cable,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  CloudUpload,
  Command,
  Copy,
  DatabaseBackup,
  Download,
  FileCode2,
  FilePlus2,
  Folder,
  FolderTree,
  Gauge,
  HardDrive,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  Network,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  RotateCcw,
  Save,
  ScrollText,
  Server,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Users,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api, ApiError, formatBytes, formatTime } from "./api";
import type {
  Backup,
  Dashboard,
  FileTransfer,
  Instance,
  InstanceDetail,
  MemberDirectory,
  MetricPoint,
  Node,
  Schedule,
  Task,
  User,
} from "./types";
import type { Permission } from "@micopanel/protocol";

type Screen =
  "overview" | "instances" | "nodes" | "tasks" | "backups" | "audit";
type Modal = "node" | "instance" | null;
type DetailTab = "console" | "metrics" | "config" | "files" | "backups" | "schedules" | "members";

const permissionLabels: Record<Permission, string> = {
  "instance.view": "查看实例",
  "instance.console": "控制台",
  "instance.power": "启停控制",
  "instance.files": "文件管理",
  "instance.config": "配置管理",
  "instance.backups": "备份恢复",
  "instance.schedules": "计划任务",
};
const permissionOptions = Object.keys(permissionLabels) as Permission[];

const nav: Array<{ id: Screen; label: string; icon: typeof LayoutDashboard }> =
  [
    { id: "overview", label: "总览", icon: LayoutDashboard },
    { id: "instances", label: "实例", icon: Boxes },
    { id: "nodes", label: "节点", icon: Network },
    { id: "tasks", label: "任务", icon: Activity },
    { id: "backups", label: "备份", icon: DatabaseBackup },
    { id: "audit", label: "审计", icon: ScrollText },
  ];

const statusText: Record<Instance["status"], string> = {
  creating: "创建中",
  offline: "已停止",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  archived: "已归档",
  error: "异常",
};

const statusClass = (status: Instance["status"] | Task["status"]): string => {
  if (["running", "succeeded"].includes(status)) return "good";
  if (["error", "failed", "cancelled"].includes(status)) return "bad";
  if (
    [
      "starting",
      "stopping",
      "creating",
      "queued",
      "delivered",
      "running",
      "retrying",
    ].includes(status)
  )
    return "wait";
  return "muted";
};

export function App() {
  const [status, setStatus] = useState<{
    setupRequired: boolean;
    user: User | null;
  }>();
  const refresh = useCallback(async () => {
    try {
      setStatus(
        await api<{ setupRequired: boolean; user: User | null }>(
          "/api/auth/status",
        ),
      );
    } catch {
      setStatus({ setupRequired: false, user: null });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!status)
    return (
      <div className="app-loading">
        <LoaderCircle size={22} className="spin" /> 正在连接控制面
      </div>
    );
  if (status.setupRequired)
    return <AuthScreen mode="setup" onComplete={refresh} />;
  if (!status.user) return <AuthScreen mode="login" onComplete={refresh} />;
  return <ControlPanel user={status.user} onSignOut={refresh} />;
}

function AuthScreen({
  mode,
  onComplete,
}: {
  mode: "setup" | "login";
  onComplete: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api(`/api/auth/${mode === "setup" ? "bootstrap" : "login"}`, {
        method: "POST",
        body: JSON.stringify({
          username: data.get("username"),
          password: data.get("password"),
        }),
      });
      await onComplete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法完成登录");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-layout">
      <section className="auth-intro">
        <Brand />
        <div className="auth-map" aria-hidden="true">
          <WorldMap />
        </div>
        <p className="eyebrow">Minecraft infrastructure control</p>
        <h1>把服务器的每一次变化，放在可见的控制面里。</h1>
        <div className="auth-steps">
          <span>
            <ShieldCheck size={16} /> 权限与审计
          </span>
          <span>
            <Cable size={16} /> 节点主动连接
          </span>
          <span>
            <HardDrive size={16} /> 归档与恢复
          </span>
        </div>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <p className="eyebrow">
            {mode === "setup" ? "Initial setup" : "Welcome back"}
          </p>
          <h2>{mode === "setup" ? "创建首个管理员" : "登录控制面"}</h2>
          <label>
            用户名
            <input
              name="username"
              autoComplete="username"
              minLength={3}
              required
              placeholder="admin"
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              minLength={10}
              required
              placeholder="至少 10 个字符"
            />
          </label>
          {error && (
            <p className="form-error">
              <CircleAlert size={16} /> {error}
            </p>
          )}
          <button className="button primary full" disabled={busy}>
            {busy ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <ChevronRight size={17} />
            )}
            {mode === "setup" ? "创建并进入面板" : "登录"}
          </button>
        </form>
      </section>
    </main>
  );
}

function ControlPanel({
  user,
  onSignOut,
}: {
  user: User;
  onSignOut: () => Promise<void>;
}) {
  const [screen, setScreen] = useState<Screen>("overview");
  const [panelOpen, setPanelOpen] = useState(false);
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<InstanceDetail>();
  const [modal, setModal] = useState<Modal>(null);
  const [message, setMessage] = useState<string>();
  const [audit, setAudit] = useState<
    Array<{
      id: string;
      action: string;
      target: string;
      detail?: string;
      createdAt: string;
    }>
  >([]);

  const refresh = useCallback(async () => {
    try {
      const next = await api<Dashboard>("/api/dashboard");
      setDashboard(next);
      setSelectedId((current) =>
        current && next.instances.some((instance) => instance.id === current)
          ? current
          : next.instances[0]?.id,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法刷新控制面");
    }
  }, []);

  const refreshDetail = useCallback(async (instanceId: string) => {
    try {
      setDetail(await api<InstanceDetail>(`/api/instances/${instanceId}`));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法加载实例");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (selectedId) void refreshDetail(selectedId);
    else setDetail(undefined);
  }, [selectedId, refreshDetail]);
  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws/ui`);
    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as {
        type: string;
        instanceId?: string;
        line?: string;
      };
      if (
        payload.type === "console.output" &&
        payload.instanceId === selectedId &&
        payload.line
      ) {
        setDetail((current) =>
          current
            ? {
                ...current,
                console: [...current.console.slice(-499), payload.line!],
              }
            : current,
        );
      } else {
        void refresh();
        if (selectedId) void refreshDetail(selectedId);
      }
    };
    return () => socket.close();
  }, [refresh, refreshDetail, selectedId]);

  const selected = dashboard?.instances.find(
    (instance) => instance.id === selectedId,
  );
  const action = async (
    instance: Instance,
    name: "start" | "stop" | "restart" | "kill" | "command",
    command?: string,
  ) => {
    if (
      name === "kill" &&
      !window.confirm(`强制停止 ${instance.name}？未保存的数据可能丢失。`)
    )
      return;
    try {
      await api(`/api/instances/${instance.id}/actions`, {
        method: "POST",
        body: JSON.stringify({ action: name, command }),
      });
      setMessage(`${instance.name}：任务已提交`);
      void refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作未完成");
    }
  };
  const retryTask = async (task: Task) => {
    try {
      await api(`/api/tasks/${task.id}/retry`, { method: "POST" });
      setMessage(`${task.type}：重试任务已提交`);
      void refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "任务未能重新提交");
    }
  };
  const signOut = async () => {
    await api("/api/auth/logout", { method: "POST" });
    await onSignOut();
  };
  const loadAudit = async () => {
    try {
      setAudit((await api<{ audits: typeof audit }>("/api/audit")).audits);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法读取审计记录");
    }
  };
  useEffect(() => {
    if (screen === "audit" && user.role === "admin") void loadAudit();
  }, [screen, user.role]);

  return (
    <div className="shell">
      <aside className={`sidebar ${panelOpen ? "open" : ""}`}>
        <div className="sidebar-brand">
          <Brand compact />
          <button
            className="icon-button close-nav"
            title="收起导航"
            onClick={() => setPanelOpen(false)}
          >
            <X size={19} />
          </button>
        </div>
        <nav>
          {nav.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${screen === id ? "active" : ""}`}
              onClick={() => {
                setScreen(id);
                setPanelOpen(false);
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "tasks" &&
                dashboard &&
                dashboard.summary.queuedTasks > 0 && (
                  <i>{dashboard.summary.queuedTasks}</i>
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="user-chip">
            <div>{user.username.slice(0, 1).toUpperCase()}</div>
            <span>
              <strong>{user.username}</strong>
              <small>{user.role === "admin" ? "管理员" : "协作者"}</small>
            </span>
          </div>
          <button
            className="icon-button"
            title="退出登录"
            onClick={() => void signOut()}
          >
            <LogOut size={18} />
          </button>
        </div>
      </aside>
      {panelOpen && (
        <button
          className="nav-scrim"
          aria-label="关闭导航"
          onClick={() => setPanelOpen(false)}
        />
      )}
      <main className="workspace">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            title="打开导航"
            onClick={() => setPanelOpen(true)}
          >
            <Menu size={20} />
          </button>
          <div>
            <p className="eyebrow">Control plane</p>
            <h2>{nav.find((item) => item.id === screen)?.label}</h2>
          </div>
          <div className="topbar-actions">
            <span className="connection">
              <i /> {dashboard?.summary.onlineNodes ?? 0}/
              {dashboard?.summary.totalNodes ?? 0} 节点在线
            </span>
            {user.role === "admin" && (
              <button
                className="button primary"
                onClick={() =>
                  setModal(screen === "nodes" ? "node" : "instance")
                }
              >
                <Plus size={17} />
                {screen === "nodes" ? "添加节点" : "创建实例"}
              </button>
            )}
          </div>
        </header>
        {!dashboard ? (
          <div className="page-loading">
            <LoaderCircle className="spin" size={22} /> 正在载入运行状态
          </div>
        ) : (
          <section className="page-content">
            {screen === "overview" && (
              <Overview
                dashboard={dashboard}
                selected={selected}
                onSelect={(instance) => {
                  setSelectedId(instance.id);
                  setScreen("instances");
                }}
                onNew={() => setModal("instance")}
              />
            )}
            {screen === "instances" && (
              <Instances
                dashboard={dashboard}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onNew={() => setModal("instance")}
              />
            )}
            {screen === "nodes" && (
              <Nodes nodes={dashboard.nodes} onNew={() => setModal("node")} />
            )}
            {screen === "tasks" && (
              <Tasks tasks={dashboard.tasks} instances={dashboard.instances} onRetry={retryTask} />
            )}
            {screen === "backups" && (
              <Backups
                backups={dashboard.backups}
                instances={dashboard.instances}
              />
            )}
            {screen === "audit" && (
              <Audit events={audit} allow={user.role === "admin"} />
            )}
            {screen === "instances" && selected && (
              <InstanceWorkspace
                key={selected.id}
                detail={detail}
                instance={selected}
                node={dashboard.nodes.find((node) => node.id === selected.nodeId)}
                onAction={action}
                notify={setMessage}
                reload={() => {
                  void refresh();
                  void refreshDetail(selected.id);
                }}
              />
            )}
          </section>
        )}
      </main>
      {modal === "node" && (
        <NodeModal
          onClose={() => setModal(null)}
          refresh={refresh}
          notify={setMessage}
        />
      )}
      {modal === "instance" && dashboard && (
        <InstanceModal
          nodes={dashboard.nodes}
          onClose={() => setModal(null)}
          refresh={refresh}
          notify={setMessage}
        />
      )}
      {message && (
        <button className="toast" onClick={() => setMessage(undefined)}>
          <Check size={16} />
          {message}
          <X size={15} />
        </button>
      )}
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <div className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      {!compact && (
        <span>
          MicoPanel<small>CONTROL</small>
        </span>
      )}
    </div>
  );
}

function WorldMap() {
  return (
    <div className="world-map">
      {Array.from({ length: 36 }, (_, index) => (
        <i
          key={index}
          className={
            [3, 4, 9, 10, 11, 16, 17, 18, 20, 21, 22, 27, 28, 29, 32].includes(
              index,
            )
              ? "land"
              : index % 7 === 0
                ? "node"
                : ""
          }
        />
      ))}
    </div>
  );
}

function Overview({
  dashboard,
  selected,
  onSelect,
  onNew,
}: {
  dashboard: Dashboard;
  selected?: Instance;
  onSelect: (instance: Instance) => void;
  onNew: () => void;
}) {
  return (
    <>
      <section className="metrics-grid">
        <Metric
          label="运行实例"
          value={`${dashboard.summary.runningInstances}`}
          suffix={`/ ${dashboard.summary.totalInstances}`}
          icon={<Power size={19} />}
          tone="mint"
        />
        <Metric
          label="在线节点"
          value={`${dashboard.summary.onlineNodes}`}
          suffix={`/ ${dashboard.summary.totalNodes}`}
          icon={<Network size={19} />}
          tone="forest"
        />
        <Metric
          label="待执行任务"
          value={String(dashboard.summary.queuedTasks)}
          icon={<Clock3 size={19} />}
          tone="amber"
        />
        <Metric
          label="最近备份"
          value={
            dashboard.backups.filter((backup) => backup.status === "available")
              .length
              ? formatTime(
                  dashboard.backups.find(
                    (backup) => backup.status === "available",
                  )?.createdAt,
                )
              : "暂无"
          }
          icon={<DatabaseBackup size={19} />}
          tone="stone"
        />
      </section>
      <section className="overview-grid">
        <section className="panel instance-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Workloads</p>
              <h3>实例运行态</h3>
            </div>
            <button className="icon-button" title="创建实例" onClick={onNew}>
              <Plus size={19} />
            </button>
          </div>
          {dashboard.instances.length ? (
            <InstanceTable
              instances={dashboard.instances
                .filter((instance) => instance.status !== "archived")
                .slice(0, 7)}
              selectedId={selected?.id}
              onSelect={onSelect}
            />
          ) : (
            <Empty
              icon={<Server size={24} />}
              title="还没有实例"
              action="创建实例"
              onAction={onNew}
            />
          )}
        </section>
        <section className="panel capacity-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Node fabric</p>
              <h3>节点容量</h3>
            </div>
            <span className="legend">
              <i /> 在线
            </span>
          </div>
          <div className="node-fabric">
            <WorldMap />
            <div className="fabric-list">
              {dashboard.nodes.length ? (
                dashboard.nodes.map((node) => (
                  <div key={node.id} className="fabric-row">
                    <span className={`dot ${node.online ? "online" : ""}`} />
                    <strong>{node.name}</strong>
                    <small>{node.online ? "已连接" : "等待 Agent"}</small>
                  </div>
                ))
              ) : (
                <p>添加节点后会在这里显示容量和连接状态。</p>
              )}
            </div>
          </div>
        </section>
      </section>
      <section className="panel task-strip">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Activity</p>
            <h3>最近任务</h3>
          </div>
        </div>
        {dashboard.tasks.length ? (
          <Tasks
            tasks={dashboard.tasks.slice(0, 5)}
            instances={dashboard.instances}
            compact
          />
        ) : (
          <p className="quiet">新任务会在这里显示执行状态。</p>
        )}
      </section>
    </>
  );
}

function Metric({
  label,
  value,
  suffix,
  icon,
  tone,
}: {
  label: string;
  value: string;
  suffix?: string;
  icon: ReactNode;
  tone: string;
}) {
  return (
    <section className={`metric ${tone}`}>
      <span className="metric-icon">{icon}</span>
      <p>{label}</p>
      <strong>
        {value}
        <small>{suffix}</small>
      </strong>
    </section>
  );
}

function Instances({
  dashboard,
  selectedId,
  onSelect,
  onNew,
}: {
  dashboard: Dashboard;
  selectedId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const visible = dashboard.instances.filter(
    (instance) => filter === "all" || instance.status === filter,
  );
  return (
    <section className="panel table-panel">
      <div className="panel-heading table-heading">
        <div>
          <p className="eyebrow">Workloads</p>
          <h3>全部实例</h3>
        </div>
        <div className="filters">
          <button
            className={filter === "all" ? "selected" : ""}
            onClick={() => setFilter("all")}
          >
            全部
          </button>
          <button
            className={filter === "running" ? "selected" : ""}
            onClick={() => setFilter("running")}
          >
            运行中
          </button>
          <button
            className={filter === "offline" ? "selected" : ""}
            onClick={() => setFilter("offline")}
          >
            已停止
          </button>
          <button
            className={filter === "error" ? "selected" : ""}
            onClick={() => setFilter("error")}
          >
            异常
          </button>
          <button className="button compact primary" onClick={onNew}>
            <Plus size={16} />
            创建
          </button>
        </div>
      </div>
      {visible.length ? (
        <InstanceTable
          instances={visible}
          selectedId={selectedId}
          onSelect={(instance) => onSelect(instance.id)}
        />
      ) : (
        <Empty
          icon={<Boxes size={24} />}
          title="没有符合条件的实例"
          action="创建实例"
          onAction={onNew}
        />
      )}
    </section>
  );
}

function InstanceTable({
  instances,
  selectedId,
  onSelect,
}: {
  instances: Instance[];
  selectedId?: string;
  onSelect: (instance: Instance) => void;
}) {
  return (
    <div className="instance-table">
      <div className="table-row table-head">
        <span>实例</span>
        <span>版本 / 类型</span>
        <span>资源上限</span>
        <span>端口</span>
        <span>状态</span>
        <span />
      </div>
      {instances.map((instance) => (
        <button
          key={instance.id}
          className={`table-row instance-row ${selectedId === instance.id ? "selected" : ""}`}
          onClick={() => onSelect(instance)}
        >
          <span className="instance-name">
            <b>{instance.name.slice(0, 2).toUpperCase()}</b>
            <strong>
              {instance.name}
              <small>{instance.kind}</small>
            </strong>
          </span>
          <span>
            {instance.version}
            <small>{instance.image.split(":")[0]}</small>
          </span>
          <span>
            {instance.limits.memoryMb >= 1024
              ? `${(instance.limits.memoryMb / 1024).toFixed(0)} GB`
              : `${instance.limits.memoryMb} MB`}
            <small>{instance.limits.cpuCores} vCPU</small>
          </span>
          <span>
            {instance.ports
              .map((port) => `${port.host}/${port.protocol}`)
              .join(", ")}
          </span>
          <span>
            <Status
              value={statusText[instance.status]}
              status={instance.status}
            />
          </span>
          <span>
            <ChevronRight size={17} />
          </span>
        </button>
      ))}
    </div>
  );
}

function Nodes({ nodes, onNew }: { nodes: Node[]; onNew: () => void }) {
  return (
    <section className="panel nodes-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Compute fabric</p>
          <h3>受管节点</h3>
        </div>
        <button className="button primary" onClick={onNew}>
          <Plus size={17} />
          添加节点
        </button>
      </div>
      {nodes.length ? (
        <div className="node-list">
          {nodes.map((node) => (
            <article className="node-card" key={node.id}>
              <div className="node-card-top">
                <span className={`dot large ${node.online ? "online" : ""}`} />
                <div>
                  <h4>{node.name}</h4>
                  <p>{node.online ? "Agent 已连接" : "等待 Agent 注册"}</p>
                </div>
                <Status
                  value={node.online ? "在线" : "离线"}
                  status={node.online ? "running" : "offline"}
                />
              </div>
              <div className="node-stats">
                <span>
                  <Server size={15} />
                  {node.agentVersion ?? "未登记"}
                </span>
                <span>
                  <Cable size={15} />
                  {node.portRangeStart} - {node.portRangeEnd}
                </span>
                <span>
                  <HardDrive size={15} />
                  {formatBytes(node.usage?.diskBytes)}
                </span>
              </div>
              <div className="util-bar">
                <i
                  style={{
                    width: `${Math.min(100, node.usage?.cpuPercent ?? 0)}%`,
                  }}
                />
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          icon={<Network size={25} />}
          title="还没有受管节点"
          action="添加节点"
          onAction={onNew}
        />
      )}
    </section>
  );
}

function Tasks({
  tasks,
  instances,
  compact = false,
  onRetry,
}: {
  tasks: Task[];
  instances: Instance[];
  compact?: boolean;
  onRetry?: (task: Task) => void;
}) {
  return (
    <div className={`tasks-list ${compact ? "compact" : ""}`}>
      {tasks.map((task) => (
        <div className="task-row" key={task.id}>
          <span className={`task-symbol ${statusClass(task.status)}`}>
            <Command size={15} />
          </span>
          <span>
            <strong>{task.type.replace("instance.", "")}</strong>
            <small>
              {instances.find((instance) => instance.id === task.instanceId)
                ?.name ?? "节点任务"}
            </small>
          </span>
          <span className="task-message">{task.status === "retrying" && task.retryAt ? `将在 ${formatTime(task.retryAt)} 自动重试（第 ${task.attempt + 1} 次）` : task.message ?? "等待节点接收"}</span>
          <span className="task-controls">
            <Status
              value={
                task.status === "succeeded"
                  ? "完成"
                  : task.status === "failed"
                    ? "失败"
                    : task.status === "retrying"
                      ? "重试中"
                      : task.status === "running"
                        ? "执行中"
                        : "排队中"
              }
              status={task.status}
            />
            {!compact && task.status === "failed" && onRetry && (
              <button className="icon-button" title="重新提交失败任务" onClick={() => onRetry(task)}>
                <RotateCcw size={15} />
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function Backups({
  backups,
  instances,
}: {
  backups: Backup[];
  instances: Instance[];
}) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Restore points</p>
          <h3>备份归档</h3>
        </div>
      </div>
      {backups.length ? (
        <div className="backup-list">
          {backups.map((backup) => (
            <div className="backup-row" key={backup.id}>
              <DatabaseBackup size={19} />
              <span>
                <strong>{backup.name}</strong>
                <small>
                  {instances.find(
                    (instance) => instance.id === backup.instanceId,
                  )?.name ?? "已删除实例"}{" "}
                  · {formatTime(backup.createdAt)}
                </small>
              </span>
              <span>
                {backup.destination === "s3" ? "S3 / MinIO" : "节点本地"}
                <small>{formatBytes(backup.sizeBytes)}</small>
              </span>
              <Status
                value={
                  backup.status === "available"
                    ? "可用"
                    : backup.status === "failed"
                      ? "失败"
                      : "处理中"
                }
                status={
                  backup.status === "available"
                    ? "succeeded"
                    : backup.status === "failed"
                      ? "failed"
                      : "running"
                }
              />
            </div>
          ))}
        </div>
      ) : (
        <Empty icon={<DatabaseBackup size={24} />} title="还没有备份归档" />
      )}
    </section>
  );
}

function Audit({
  events,
  allow,
}: {
  events: Array<{
    id: string;
    action: string;
    target: string;
    detail?: string;
    createdAt: string;
  }>;
  allow: boolean;
}) {
  if (!allow)
    return (
      <section className="panel">
        <Empty
          icon={<ShieldCheck size={24} />}
          title="审计记录仅向管理员开放"
        />
      </section>
    );
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Security trail</p>
          <h3>操作审计</h3>
        </div>
      </div>
      {events.length ? (
        <div className="audit-list">
          {events.map((event) => (
            <div className="audit-row" key={event.id}>
              <ShieldCheck size={17} />
              <span>
                <strong>{event.action}</strong>
                <small>
                  {event.target}
                  {event.detail ? ` · ${event.detail}` : ""}
                </small>
              </span>
              <time>{formatTime(event.createdAt)}</time>
            </div>
          ))}
        </div>
      ) : (
        <p className="quiet">尚未记录控制面操作。</p>
      )}
    </section>
  );
}

function InstanceWorkspace({
  detail,
  instance,
  node,
  onAction,
  notify,
  reload,
}: {
  detail?: InstanceDetail;
  instance: Instance;
  node?: Node;
  onAction: (
    instance: Instance,
    action: "start" | "stop" | "restart" | "kill" | "command",
    command?: string,
  ) => Promise<void>;
  notify: (message?: string) => void;
  reload: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>("console");
  const [command, setCommand] = useState("");
  const [files, setFiles] = useState<
    Array<{ path: string; content?: string; size: number; modifiedAt: string }>
  >([]);
  const [directory, setDirectory] = useState("/");
  const [editor, setEditor] = useState<{ path: string; content: string }>();
  const [fileBusy, setFileBusy] = useState(false);
  const [transfer, setTransfer] = useState<FileTransfer>();
  useEffect(() => {
    setTab("console");
    setDirectory("/");
    setEditor(undefined);
    setTransfer(undefined);
  }, [instance.id]);
  useEffect(() => {
    setFiles(detail?.files ?? []);
  }, [detail]);
  useEffect(() => {
    if (!transfer || !["queued", "receiving"].includes(transfer.status)) return;
    let active = true;
    const check = async () => {
      try {
        const result = await api<{ transfer: FileTransfer }>(
          `/api/instances/${instance.id}/file-transfers/${transfer.id}`,
        );
        if (active) setTransfer(result.transfer);
      } catch (error) {
        if (active)
          notify(
            error instanceof Error ? error.message : "无法读取文件传输状态",
          );
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [instance.id, notify, transfer]);
  const entries = useMemo(() => {
    const prefix = directory === "/" ? "/" : `${directory}/`;
    const folders = new Set<string>();
    const directFiles: typeof files = [];
    for (const file of files) {
      if (!file.path.startsWith(prefix)) continue;
      const remainder = file.path.slice(prefix.length);
      if (!remainder) continue;
      const separator = remainder.indexOf("/");
      if (separator >= 0)
        folders.add(`${prefix}${remainder.slice(0, separator)}`);
      else directFiles.push(file);
    }
    return {
      folders: [...folders].sort(),
      files: directFiles.sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
    };
  }, [directory, files]);
  const crumbs = directory === "/" ? [] : directory.slice(1).split("/");
  const sendCommand = async (event: FormEvent) => {
    event.preventDefault();
    if (!command.trim()) return;
    await onAction(instance, "command", command);
    setCommand("");
  };
  const loadFiles = async () => {
    try {
      await api(`/api/instances/${instance.id}/files/sync`, { method: "POST" });
      notify("文件同步任务已提交");
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法读取文件");
    }
  };
  const openFile = async (file: { path: string }) => {
    setFileBusy(true);
    setEditor({ path: file.path, content: "" });
    try {
      await api(`/api/instances/${instance.id}/files/read`, {
        method: "POST",
        body: JSON.stringify({ path: file.path }),
      });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolvePromise) =>
          window.setTimeout(resolvePromise, 300),
        );
        const result = await api<{ files: typeof files }>(
          `/api/instances/${instance.id}/files`,
        );
        const current = result.files.find(
          (candidate) => candidate.path === file.path,
        );
        if (typeof current?.content === "string") {
          setFiles(result.files);
          setEditor({ path: file.path, content: current.content });
          return;
        }
      }
      throw new Error("读取任务仍在等待节点响应");
    } catch (error) {
      setEditor(undefined);
      notify(error instanceof Error ? error.message : "无法打开文件");
    } finally {
      setFileBusy(false);
    }
  };
  const saveFile = async () => {
    if (!editor) return;
    setFileBusy(true);
    try {
      await api(`/api/instances/${instance.id}/files`, {
        method: "PUT",
        body: JSON.stringify(editor),
      });
      setFiles((current) =>
        current.map((file) =>
          file.path === editor.path
            ? {
                ...file,
                content: editor.content,
                size: new Blob([editor.content]).size,
                modifiedAt: new Date().toISOString(),
              }
            : file,
        ),
      );
      notify("文件保存任务已提交");
    } catch (error) {
      notify(error instanceof Error ? error.message : "文件未保存");
    } finally {
      setFileBusy(false);
    }
  };
  const uploadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const path = `${directory === "/" ? "" : directory}/${file.name}`;
    setFileBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const result = await api<{ transfer: FileTransfer }>(
        `/api/instances/${instance.id}/files/upload?path=${encodeURIComponent(path)}`,
        { method: "POST", body },
      );
      setTransfer(result.transfer);
      notify(`正在上传 ${file.name}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "文件未上传");
    } finally {
      setFileBusy(false);
    }
  };
  const requestDownload = async (path: string) => {
    try {
      const result = await api<{ transfer: FileTransfer }>(
        `/api/instances/${instance.id}/files/download`,
        { method: "POST", body: JSON.stringify({ path }) },
      );
      setTransfer(result.transfer);
      notify("正在从节点准备下载文件");
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法准备下载文件");
    }
  };
  const backup = async () => {
    try {
      await api(`/api/instances/${instance.id}/backups`, {
        method: "POST",
        body: JSON.stringify({ destination: "local" }),
      });
      notify("备份任务已提交");
      reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : "备份任务未完成");
    }
  };
  return (
    <section className="instance-workspace">
      <div className="worktop">
        <div>
          <span className="back-label">正在管理</span>
          <h3>
            {instance.name}
            <Status
              value={statusText[instance.status]}
              status={instance.status}
            />
          </h3>
          <p>
            {instance.kind} · {instance.version} ·{" "}
            {instance.ports
              .map((port) => `${port.host}/${port.protocol}`)
              .join(", ")}
          </p>
        </div>
        <div className="power-controls">
          <button
            className="icon-button action-good"
            title="启动"
            disabled={
              instance.status === "running" || instance.status === "starting"
            }
            onClick={() => void onAction(instance, "start")}
          >
            <Play size={17} />
          </button>
          <button
            className="icon-button"
            title="重启"
            onClick={() => void onAction(instance, "restart")}
          >
            <RotateCcw size={17} />
          </button>
          <button
            className="icon-button action-warn"
            title="停止"
            disabled={instance.status === "offline"}
            onClick={() => void onAction(instance, "stop")}
          >
            <Pause size={17} />
          </button>
          <button
            className="icon-button action-bad"
            title="强制停止"
            onClick={() => void onAction(instance, "kill")}
          >
            <Power size={17} />
          </button>
        </div>
      </div>
      <div className="detail-tabs">
        {(["console", "metrics", "config", "files", "backups", "schedules", "members"] as DetailTab[]).map(
          (item) => (
            <button
              key={item}
              className={tab === item ? "active" : ""}
              onClick={() => {
                setTab(item);
                if (item === "files") void loadFiles();
              }}
            >
              {item === "console"
                ? "控制台"
                : item === "metrics"
                  ? "资源"
                : item === "config"
                  ? "配置"
                  : item === "files"
                  ? "文件"
                  : item === "backups"
                    ? "备份"
                  : item === "schedules"
                    ? "计划任务"
                    : "协作者"}
            </button>
          ),
        )}
      </div>
      {tab === "console" && (
        <div className="console-tool">
          <div className="console-head">
            <span>
              <Terminal size={15} /> 实时控制台
            </span>
            <span>{detail?.console.length ?? 0} 行</span>
          </div>
          <pre>
            {detail?.console.length
              ? detail.console.join("\n")
              : "等待节点输出..."}
          </pre>
          <form onSubmit={sendCommand} className="command-line">
            <span>&gt;</span>
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="输入服务器命令"
            />
            <button className="icon-button" title="发送命令" type="submit">
              <ChevronRight size={18} />
            </button>
          </form>
        </div>
      )}
      {tab === "metrics" && <InstanceMetrics instance={instance} />}
      {tab === "config" && <ConfigurationTool detail={detail} instance={instance} node={node} notify={notify} reload={reload} />}
      {tab === "files" && (
        <div className="file-tool file-manager">
          <div className="tool-title">
            <span>
              <FolderTree size={18} /> 文件
            </span>
            <span className="file-actions">
              <button
                className="icon-button"
                title="返回上级目录"
                disabled={directory === "/"}
                onClick={() =>
                  setDirectory(
                    directory.slice(0, directory.lastIndexOf("/")) || "/",
                  )
                }
              >
                <ChevronLeft size={16} />
              </button>
              <label className="icon-button" title="上传到当前目录">
                <FilePlus2 size={16} />
                <input
                  type="file"
                  onChange={(event) => void uploadFile(event)}
                />
              </label>
              <button
                className="icon-button"
                title="刷新文件"
                onClick={() => void loadFiles()}
              >
                <RotateCcw size={16} />
              </button>
            </span>
          </div>
          <div className="file-breadcrumb">
            <button
              onClick={() => setDirectory("/")}
              className={directory === "/" ? "current" : ""}
            >
              根目录
            </button>
            {crumbs.map((crumb, index) => {
              const path = `/${crumbs.slice(0, index + 1).join("/")}`;
              return (
                <button
                  key={path}
                  onClick={() => setDirectory(path)}
                  className={path === directory ? "current" : ""}
                >
                  /{crumb}
                </button>
              );
            })}
          </div>
          <div className="file-browser">
            {" "}
            <div className="file-list">
              {entries.folders.map((path) => (
                <button
                  key={path}
                  className="file-row folder-row"
                  onClick={() => setDirectory(path)}
                >
                  <Folder size={17} />
                  <span>
                    <strong>{path.slice(path.lastIndexOf("/") + 1)}</strong>
                    <small>目录</small>
                  </span>
                  <ChevronRight size={15} />
                </button>
              ))}
              {entries.files.map((file) => (
                <div
                  className={`file-row ${editor?.path === file.path ? "selected" : ""}`}
                  key={file.path}
                >
                  <button
                    className="file-open"
                    onClick={() => void openFile(file)}
                  >
                    <FileCode2 size={17} />
                    <span>
                      <strong>
                        {file.path.slice(file.path.lastIndexOf("/") + 1)}
                      </strong>
                      <small>
                        {formatBytes(file.size)} · {formatTime(file.modifiedAt)}
                      </small>
                    </span>
                  </button>
                  <button
                    className="icon-button"
                    title="下载文件"
                    onClick={() => void requestDownload(file.path)}
                  >
                    <Download size={15} />
                  </button>
                </div>
              ))}
              {!entries.folders.length && !entries.files.length && (
                <p className="quiet">当前目录为空</p>
              )}
            </div>
            <div className="file-editor">
              {editor ? (
                <>
                  <div className="editor-head">
                    <span>
                      {fileBusy ? (
                        <LoaderCircle size={15} className="spin" />
                      ) : (
                        <FileCode2 size={15} />
                      )}
                      {editor.path}
                    </span>
                    <button
                      className="button compact primary"
                      disabled={fileBusy}
                      onClick={() => void saveFile()}
                    >
                      <Save size={15} />
                      保存
                    </button>
                  </div>
                  <textarea
                    value={editor.content}
                    spellCheck={false}
                    onChange={(event) =>
                      setEditor({ ...editor, content: event.target.value })
                    }
                  />
                </>
              ) : (
                <div className="editor-empty">
                  <FileCode2 size={24} />
                  <p>未选择文件</p>
                </div>
              )}
            </div>
          </div>
          {transfer && (
            <div className={`file-transfer ${transfer.status}`}>
              <span>
                {transfer.status === "failed" ? (
                  <CircleAlert size={16} />
                ) : transfer.status === "available" ? (
                  <Check size={16} />
                ) : (
                  <LoaderCircle size={16} className="spin" />
                )}
              </span>
              <div>
                <strong>
                  {transfer.direction === "upload" ? "上传文件" : "准备下载"} ·{" "}
                  {transfer.fileName}
                </strong>
                <small>
                  {transfer.status === "available"
                    ? "传输已完成"
                    : transfer.status === "failed"
                      ? (transfer.error ?? "传输失败")
                      : "正在等待节点处理"}
                </small>
              </div>
              {transfer.direction === "download" &&
                transfer.status === "available" && (
                  <a
                    className="button compact"
                    href={`/api/instances/${instance.id}/file-transfers/${transfer.id}/download`}
                  >
                    <Download size={15} />
                    下载
                  </a>
                )}
            </div>
          )}
        </div>
      )}
      {tab === "schedules" && <ScheduleTool detail={detail} instance={instance} notify={notify} reload={reload} />}
      {tab === "members" && <MembersTool instance={instance} notify={notify} />}
      {tab === "backups" && (
        <div className="backup-tool">
          <button className="button primary" onClick={() => void backup()}>
            <DatabaseBackup size={17} />
            创建备份
          </button>
          {detail?.backups.length ? (
            <Backups backups={detail.backups} instances={[instance]} />
          ) : (
            <p className="quiet">创建备份后可在此查看归档状态。</p>
          )}
        </div>
      )}
    </section>
  );
}

function InstanceMetrics({ instance }: { instance: Instance }) {
  const [minutes, setMinutes] = useState(60);
  const [points, setPoints] = useState<MetricPoint[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await api<{ metrics: MetricPoint[] }>(`/api/instances/${instance.id}/metrics?minutes=${minutes}`);
        if (active) {
          setPoints(result.metrics);
          setError(undefined);
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "资源曲线暂时无法读取");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [instance.id, minutes]);

  const latest = points[points.length - 1];
  return (
    <div className="metrics-tool">
      <div className="tool-title">
        <span><Gauge size={18} /> 资源曲线</span>
        <span>{points.length ? `${points.length} 个采样` : "等待节点上报"}</span>
      </div>
      <div className="metrics-toolbar">
        <span>时间范围</span>
        {[15, 60, 360, 1440].map((range) => (
          <button key={range} type="button" className={minutes === range ? "selected" : ""} onClick={() => setMinutes(range)}>
            {range < 60 ? `${range} 分钟` : range === 60 ? "1 小时" : range === 360 ? "6 小时" : "24 小时"}
          </button>
        ))}
      </div>
      <div className="metrics-summary">
        <MetricReadout label="CPU" value={latest ? `${latest.cpuPercent.toFixed(1)}%` : "--"} />
        <MetricReadout label="内存" value={latest ? `${formatBytes(latest.memoryBytes)} / ${formatBytes(latest.memoryLimitBytes)}` : "--"} />
        <MetricReadout label="累计 RX" value={latest ? formatBytes(latest.networkRxBytes) : "--"} />
        <MetricReadout label="PID" value={latest?.pids === undefined ? "--" : String(latest.pids)} />
      </div>
      {error ? <p className="metric-error">{error}</p> : null}
      <div className="metric-charts">
        <MetricChart title="CPU 使用率" points={points.map((point) => point.cpuPercent)} suffix="%" color="#56d59b" max={100} />
        <MetricChart title="内存占用" points={points.map((point) => point.memoryBytes)} suffix="" color="#e4b45b" max={Math.max(1, ...points.map((point) => point.memoryLimitBytes))} format={formatBytes} />
      </div>
      {!points.length && !error ? <p className="metric-empty">暂无采样数据，节点连接并上报后会显示曲线。</p> : null}
    </div>
  );
}

function MetricReadout({ label, value }: { label: string; value: string }) {
  return <div className="metric-readout"><small>{label}</small><strong>{value}</strong></div>;
}

function MetricChart({ title, points, suffix, color, max, format = (value: number) => value.toFixed(0) }: { title: string; points: number[]; suffix: string; color: string; max: number; format?: (value: number) => string }) {
  const width = 640;
  const height = 180;
  const padding = 16;
  const chartHeight = height - padding * 2;
  const chartWidth = width - padding * 2;
  const path = points.map((point, index) => {
    const x = points.length === 1 ? width / 2 : padding + (index / (points.length - 1)) * chartWidth;
    const y = height - padding - Math.min(1, Math.max(0, point / Math.max(1, max))) * chartHeight;
    return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <article className="metric-chart">
      <div className="metric-chart-head"><strong>{title}</strong><small>{points.length ? `${format(points[points.length - 1])}${suffix}` : "暂无数据"}</small></div>
      {points.length ? (
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} preserveAspectRatio="none">
          <line x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
          <line x1={padding} x2={width - padding} y1={padding} y2={padding} />
          <path d={path} style={{ stroke: color }} />
        </svg>
      ) : <div className="metric-chart-empty">等待节点连接</div>}
    </article>
  );
}

function ScheduleTool({
  detail,
  instance,
  notify,
  reload,
}: {
  detail?: InstanceDetail;
  instance: Instance;
  notify: (message?: string) => void;
  reload: () => void;
}) {
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 4 * * *");
  const [action, setAction] = useState<Schedule["action"]>("backup");
  const [command, setCommand] = useState("");
  const [destination, setDestination] = useState<"local" | "s3">("local");
  const [editing, setEditing] = useState<Schedule>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName("");
    setCron("0 4 * * *");
    setAction("backup");
    setCommand("");
    setDestination("local");
    setEditing(undefined);
  }, [instance.id]);

  const reset = () => {
    setName("");
    setCron("0 4 * * *");
    setAction("backup");
    setCommand("");
    setDestination("local");
    setEditing(undefined);
  };
  const payloadForAction = (): Record<string, unknown> => {
    if (action === "command") {
      if (!command.trim()) throw new Error("请输入计划任务命令");
      return { command: command.trim() };
    }
    if (action === "backup") return { destination };
    return {};
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = { name, cron, action, payload: payloadForAction() };
      await api(
        editing
          ? `/api/instances/${instance.id}/schedules/${editing.id}`
          : `/api/instances/${instance.id}/schedules`,
        {
          method: editing ? "PUT" : "POST",
          body: JSON.stringify(editing ? { ...payload, enabled: editing.enabled } : payload),
        },
      );
      notify(editing ? "计划任务已更新" : "计划任务已创建");
      reset();
      reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : "计划任务未保存");
    } finally {
      setBusy(false);
    }
  };
  const beginEdit = (schedule: Schedule) => {
    setEditing(schedule);
    setName(schedule.name);
    setCron(schedule.cron);
    setAction(schedule.action);
    setCommand(typeof schedule.payload.command === "string" ? schedule.payload.command : "");
    setDestination(schedule.payload.destination === "s3" ? "s3" : "local");
  };
  const writeEnabled = async (schedule: Schedule, enabled: boolean) => {
    setBusy(true);
    try {
      await api(`/api/instances/${instance.id}/schedules/${schedule.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: schedule.name,
          cron: schedule.cron,
          action: schedule.action,
          payload: schedule.payload,
          enabled,
        }),
      });
      notify(enabled ? "计划任务已启用" : "计划任务已暂停");
      reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : "计划任务状态未更新");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (schedule: Schedule) => {
    if (!window.confirm(`删除计划任务“${schedule.name}”？`)) return;
    setBusy(true);
    try {
      await api(`/api/instances/${instance.id}/schedules/${schedule.id}`, { method: "DELETE" });
      if (editing?.id === schedule.id) reset();
      notify("计划任务已删除");
      reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : "计划任务未删除");
    } finally {
      setBusy(false);
    }
  };
  const schedules = detail?.schedules ?? [];
  return (
    <div className="schedule-tool schedule-manager">
      <div className="tool-title">
        <span><Clock3 size={18} /> {editing ? "编辑计划任务" : "计划任务"}</span>
        <span>{schedules.length} 条</span>
      </div>
      <form className="schedule-form" onSubmit={save}>
        <label>
          任务名称
          <input value={name} maxLength={64} required placeholder="每日备份" onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Cron
          <input value={cron} required placeholder="0 4 * * *" onChange={(event) => setCron(event.target.value)} />
        </label>
        <label>
          动作
          <select value={action} onChange={(event) => setAction(event.target.value as Schedule["action"])}>
            <option value="backup">备份</option>
            <option value="restart">重启实例</option>
            <option value="command">执行命令</option>
          </select>
        </label>
        {action === "backup" && (
          <label>
            备份目标
            <select value={destination} onChange={(event) => setDestination(event.target.value as "local" | "s3")}>
              <option value="local">节点本地</option>
              <option value="s3">S3 / MinIO</option>
            </select>
          </label>
        )}
        {action === "command" && (
          <label className="schedule-command">
            控制台命令
            <input value={command} required placeholder="say 服务器即将重启" onChange={(event) => setCommand(event.target.value)} />
          </label>
        )}
        <div className="schedule-form-actions">
          <button className="button primary" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" /> : editing ? <Save size={16} /> : <Plus size={16} />}
            {editing ? "保存计划任务" : "添加计划任务"}
          </button>
          {editing && <button className="icon-button" type="button" title="取消编辑" onClick={reset}><X size={16} /></button>}
        </div>
      </form>
      {schedules.length ? schedules.map((schedule) => (
        <div className="schedule-row schedule-manager-row" key={schedule.id}>
          <Clock3 size={17} />
          <span>
            <strong>{schedule.name}</strong>
            <small>{schedule.cron} · {schedule.action === "backup" ? `备份至 ${schedule.payload.destination === "s3" ? "S3 / MinIO" : "节点本地"}` : schedule.action === "restart" ? "重启实例" : `命令：${String(schedule.payload.command ?? "")}`} · 下次 {formatTime(schedule.nextRunAt)}</small>
          </span>
          <Status value={schedule.enabled ? "已启用" : "已暂停"} status={schedule.enabled ? "running" : "offline"} />
          <div className="schedule-row-actions">
            <button className="icon-button" title="编辑计划任务" disabled={busy} onClick={() => beginEdit(schedule)}><Pencil size={14} /></button>
            <button className="icon-button" title={schedule.enabled ? "暂停计划任务" : "启用计划任务"} disabled={busy} onClick={() => void writeEnabled(schedule, !schedule.enabled)}>{schedule.enabled ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}</button>
            <button className="icon-button action-bad" title="删除计划任务" disabled={busy} onClick={() => void remove(schedule)}><Trash2 size={14} /></button>
          </div>
        </div>
      )) : <p className="quiet">还没有计划任务。</p>}
    </div>
  );
}

type EnvironmentEntry = { id: string; key: string; value: string };

function ConfigurationTool({
  detail,
  instance,
  node,
  notify,
  reload,
}: {
  detail?: InstanceDetail;
  instance: Instance;
  node?: Node;
  notify: (message?: string) => void;
  reload: () => void;
}) {
  const [version, setVersion] = useState(instance.version);
  const [port, setPort] = useState(instance.ports[0]?.host ?? 25565);
  const [limits, setLimits] = useState(instance.limits);
  const [environment, setEnvironment] = useState<EnvironmentEntry[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const appliedAt = detail?.instance.updatedAt;

  useEffect(() => {
    const editable = detail?.configuration.environment ?? {};
    setVersion(detail?.instance.version ?? instance.version);
    setPort(detail?.instance.ports[0]?.host ?? instance.ports[0]?.host ?? 25565);
    setLimits(detail?.instance.limits ?? instance.limits);
    setEnvironment(Object.entries(editable).map(([key, value], index) => ({ id: `${key}-${index}`, key, value })));
    setConfirmed(false);
  }, [appliedAt, detail?.configuration.environment, instance.id]);

  const updateLimit = (key: keyof Instance["limits"], value: number) => {
    setLimits((current) => ({ ...current, [key]: value }));
  };
  const updateEnvironment = (id: string, field: "key" | "value", value: string) => {
    setEnvironment((current) => current.map((entry) => entry.id === id ? { ...entry, [field]: value } : entry));
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmed) {
      notify("请先确认将重建运行容器");
      return;
    }
    const nextEnvironment: Record<string, string> = {};
    for (const entry of environment) {
      const key = entry.key.trim();
      if (!key) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        notify("环境变量名称只能包含字母、数字和下划线");
        return;
      }
      if (key in nextEnvironment) {
        notify("环境变量名称不能重复");
        return;
      }
      nextEnvironment[key] = entry.value;
    }
    setSaving(true);
    try {
      await api(`/api/instances/${instance.id}/config`, {
        method: "PUT",
        body: JSON.stringify({ version, port, limits, environment: nextEnvironment, confirmRecreate: true }),
      });
      notify("配置重建任务已提交，容器将在节点端重新创建");
      reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : "实例配置未保存");
    } finally {
      setSaving(false);
    }
  };
  const managed = detail?.configuration.managedEnvironment ?? {};
  const mappedPort = instance.ports[0];
  return (
    <div className="config-tool">
      <div className="tool-title">
        <span><Settings2 size={18} /> 运行配置</span>
        <span className="config-node">{node ? `${node.name} ${node.portRangeStart}-${node.portRangeEnd}` : "等待节点信息"}</span>
      </div>
      <form className="config-form" onSubmit={save}>
        <div className="config-recreate">
          <CircleAlert size={17} />
          <span>保存会保留实例数据目录，但会停止并重新创建受管容器。</span>
        </div>
        <section className="config-section">
          <div className="config-section-heading"><Server size={16} /><span>服务端与网络</span></div>
          <div className="config-grid">
            <label>
              服务端版本
              <input value={version} maxLength={64} required onChange={(event) => setVersion(event.target.value)} />
            </label>
            <label>
              游戏端口
              <input type="number" value={port} min={node?.portRangeStart ?? 1024} max={node?.portRangeEnd ?? 65535} required onChange={(event) => setPort(Number(event.target.value))} />
              <small>容器 {mappedPort?.container ?? 25565}/{mappedPort?.protocol ?? "tcp"}</small>
            </label>
          </div>
        </section>
        <section className="config-section">
          <div className="config-section-heading"><HardDrive size={16} /><span>资源预留</span></div>
          <div className="config-grid config-grid-four">
            <label>
              内存 MB
              <input type="number" value={limits.memoryMb} min="512" max="262144" required onChange={(event) => updateLimit("memoryMb", Number(event.target.value))} />
            </label>
            <label>
              vCPU
              <input type="number" value={limits.cpuCores} min="0.25" max="128" step="0.25" required onChange={(event) => updateLimit("cpuCores", Number(event.target.value))} />
            </label>
            <label>
              PID 上限
              <input type="number" value={limits.pids} min="64" max="32768" required onChange={(event) => updateLimit("pids", Number(event.target.value))} />
            </label>
            <label>
              数据容量 MB
              <input type="number" value={limits.diskMb} min="1024" max="10485760" required onChange={(event) => updateLimit("diskMb", Number(event.target.value))} />
            </label>
          </div>
        </section>
        <section className="config-section">
          <div className="config-section-heading"><Command size={16} /><span>环境变量</span></div>
          <p className="config-note">仅保存额外变量。服务端模板、EULA、版本、内存和自定义入口由面板锁定。</p>
          <div className="environment-list">
            {environment.map((entry) => (
              <div className="environment-row" key={entry.id}>
                <input aria-label="环境变量名称" value={entry.key} maxLength={128} placeholder="MOTD" onChange={(event) => updateEnvironment(entry.id, "key", event.target.value)} />
                <input aria-label="环境变量值" value={entry.value} maxLength={4096} placeholder="欢迎来到服务器" onChange={(event) => updateEnvironment(entry.id, "value", event.target.value)} />
                <button className="icon-button" type="button" title="移除环境变量" onClick={() => setEnvironment((current) => current.filter((candidate) => candidate.id !== entry.id))}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
          <button className="button compact" type="button" onClick={() => setEnvironment((current) => [...current, { id: `new-${Date.now()}`, key: "", value: "" }])}><Plus size={15} /> 添加变量</button>
          {!!Object.keys(managed).length && <div className="managed-environment"><span>受管变量</span>{Object.entries(managed).map(([key, value]) => <code key={key}>{key}={value}</code>)}</div>}
        </section>
        <div className="config-save-row">
          <label className="check-row">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            我确认保存后会重建运行容器
          </label>
          <button className="button primary" disabled={saving || !confirmed}>
            {saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />} 保存并重建
          </button>
        </div>
      </form>
    </div>
  );
}

function MembersTool({
  instance,
  notify,
}: {
  instance: Instance;
  notify: (message?: string) => void;
}) {
  const [directory, setDirectory] = useState<MemberDirectory>();
  const [selectedUserId, setSelectedUserId] = useState("");
  const [newPermissions, setNewPermissions] = useState<Permission[]>([
    "instance.view",
  ]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDirectory(
        await api<MemberDirectory>(`/api/instances/${instance.id}/members`),
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法读取协作者");
    }
  }, [instance.id, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!directory) return;
    const assigned = new Set(directory.members.map((member) => member.userId));
    const available = directory.users.filter((user) => !assigned.has(user.id));
    setSelectedUserId((current) =>
      current && available.some((user) => user.id === current)
        ? current
        : available[0]?.id ?? "",
    );
  }, [directory]);

  const addMember = async () => {
    if (!selectedUserId || !newPermissions.length) return;
    setBusy(true);
    try {
      await api(`/api/instances/${instance.id}/members/${selectedUserId}`, {
        method: "PUT",
        body: JSON.stringify({ permissions: newPermissions }),
      });
      notify("协作者权限已保存");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "协作者未保存");
    } finally {
      setBusy(false);
    }
  };

  const createAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const result = await api<{ user: User }>("/api/users", {
        method: "POST",
        body: JSON.stringify({
          username: data.get("username"),
          password: data.get("password"),
          role: "user",
        }),
      });
      event.currentTarget.reset();
      await load();
      setSelectedUserId(result.user.id);
      notify("本地账号已创建");
    } catch (error) {
      notify(error instanceof Error ? error.message : "账号未创建");
    } finally {
      setBusy(false);
    }
  };

  if (!directory) {
    return (
      <div className="member-tool member-loading">
        <LoaderCircle size={18} className="spin" />
      </div>
    );
  }

  const assigned = new Set(directory.members.map((member) => member.userId));
  const availableUsers = directory.users.filter((user) => !assigned.has(user.id));

  return (
    <div className="member-tool">
      <div className="member-head">
        <div>
          <span className="tool-kicker">ACCESS CONTROL</span>
          <strong>实例协作者</strong>
        </div>
        <button
          className="icon-button"
          title="刷新协作者"
          onClick={() => void load()}
        >
          <RotateCcw size={15} />
        </button>
      </div>
      <div className="member-row member-owner">
        <span className="member-avatar">{directory.owner.username.slice(0, 1).toUpperCase()}</span>
        <span className="member-identity">
          <strong>{directory.owner.username}</strong>
          <small>实例所有者 · 全部权限</small>
        </span>
        <span className="member-role"><ShieldCheck size={14} /> Owner</span>
      </div>
      {directory.canManage && (
        <div className="member-add">
          <div className="member-section-title"><Users size={15} /> 添加协作者</div>
          <div className="member-add-fields">
            <label>
              账号
              <select value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)} disabled={!availableUsers.length}>
                {availableUsers.length ? availableUsers.map((user) => <option value={user.id} key={user.id}>{user.username}</option>) : <option value="">暂无可选账号</option>}
              </select>
            </label>
            <button className="button compact primary" disabled={busy || !selectedUserId || !newPermissions.length} onClick={() => void addMember()}>
              <Plus size={15} />保存授权
            </button>
          </div>
          <PermissionChecklist value={newPermissions} onChange={setNewPermissions} />
          {directory.canCreateUsers && <form className="member-account-form" onSubmit={createAccount}>
            <span className="member-section-title"><Plus size={15} /> 创建本地账号</span>
            <label>用户名<input name="username" minLength={3} maxLength={32} required placeholder="builder" /></label>
            <label>初始密码<input name="password" type="password" minLength={10} required placeholder="至少 10 位" /></label>
            <button className="button compact" disabled={busy}>创建账号</button>
          </form>}
        </div>
      )}
      <div className="member-list">
        {directory.members.length ? directory.members.map((member) => <CollaboratorRow key={member.userId} instanceId={instance.id} member={member} canManage={directory.canManage} busy={busy} notify={notify} onSaved={load} />) : <p className="member-empty">暂无协作者</p>}
      </div>
      {!directory.canManage && <p className="member-readonly">当前账号仅可查看协作者名单。</p>}
    </div>
  );
}

function CollaboratorRow({
  instanceId,
  member,
  canManage,
  busy,
  notify,
  onSaved,
}: {
  instanceId: string;
  member: MemberDirectory["members"][number];
  canManage: boolean;
  busy: boolean;
  notify: (message?: string) => void;
  onSaved: () => Promise<void>;
}) {
  const [permissions, setPermissions] = useState<Permission[]>(member.permissions);
  const [saving, setSaving] = useState(false);
  useEffect(() => setPermissions(member.permissions), [member.permissions]);
  const save = async () => {
    if (!permissions.length) return;
    setSaving(true);
    try {
      await api(`/api/instances/${instanceId}/members/${member.userId}`, { method: "PUT", body: JSON.stringify({ permissions }) });
      notify("协作者权限已更新");
      await onSaved();
    } catch (error) { notify(error instanceof Error ? error.message : "权限未更新"); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!window.confirm(`移除 ${member.user.username} 的实例权限？`)) return;
    setSaving(true);
    try {
      await api(`/api/instances/${instanceId}/members/${member.userId}`, { method: "DELETE" });
      notify("协作者已移除");
      await onSaved();
    } catch (error) { notify(error instanceof Error ? error.message : "协作者未移除"); }
    finally { setSaving(false); }
  };
  return <article className="member-row collaborator-row">
    <span className="member-avatar">{member.user.username.slice(0, 1).toUpperCase()}</span>
    <span className="member-identity"><strong>{member.user.username}</strong><small>{member.user.role === "admin" ? "管理员账号" : "本地账号"}</small></span>
    <div className="member-permissions"><PermissionChecklist value={permissions} onChange={setPermissions} disabled={!canManage || saving || busy} /></div>
    {canManage && <div className="member-row-actions"><button className="icon-button" title="保存权限" disabled={saving || busy || !permissions.length} onClick={() => void save()}><Save size={15} /></button><button className="icon-button action-bad" title="移除协作者" disabled={saving || busy} onClick={() => void remove()}><Trash2 size={15} /></button></div>}
  </article>;
}

function PermissionChecklist({
  value,
  onChange,
  disabled = false,
}: {
  value: Permission[];
  onChange: (value: Permission[]) => void;
  disabled?: boolean;
}) {
  return <div className="permission-grid">{permissionOptions.map((permission) => <label key={permission} className="permission-check"><input type="checkbox" checked={value.includes(permission)} disabled={disabled} onChange={() => onChange(value.includes(permission) ? value.filter((item) => item !== permission) : [...value, permission])} /><span>{permissionLabels[permission]}</span></label>)}</div>;
}

function NodeModal({
  onClose,
  refresh,
  notify,
}: {
  onClose: () => void;
  refresh: () => Promise<void>;
  notify: (message?: string) => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const response = await api<{ enrollmentToken: string }>("/api/nodes", {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          portRangeStart: Number(data.get("start")),
          portRangeEnd: Number(data.get("end")),
        }),
      });
      setToken(response.enrollmentToken);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "节点未创建");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="添加受管节点" onClose={onClose}>
      {token ? (
        <div className="enrollment">
          <ShieldCheck size={28} />
          <p>仅显示一次的注册令牌</p>
          <code>{token}</code>
          <button
            className="button"
            onClick={() => void navigator.clipboard.writeText(token)}
          >
            <Copy size={16} />
            复制令牌
          </button>
          <pre>{`CONTROLLER_URL=${location.origin}\nENROLLMENT_TOKEN=${token}`}</pre>
        </div>
      ) : (
        <form className="dialog-form" onSubmit={submit}>
          <label>
            节点名称
            <input name="name" required placeholder="杭州-01" />
          </label>
          <div className="two-inputs">
            <label>
              起始端口
              <input
                name="start"
                type="number"
                defaultValue="25565"
                min="1024"
              />
            </label>
            <label>
              结束端口
              <input name="end" type="number" defaultValue="25665" min="1025" />
            </label>
          </div>
          <button className="button primary" disabled={busy}>
            {busy && <LoaderCircle size={16} className="spin" />}生成注册令牌
          </button>
        </form>
      )}
    </Dialog>
  );
}

function InstanceModal({
  nodes,
  onClose,
  refresh,
  notify,
}: {
  nodes: Node[];
  onClose: () => void;
  refresh: () => Promise<void>;
  notify: (message?: string) => void;
}) {
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
        if (!(file instanceof File) || file.size === 0)
          throw new Error("请选择 JAR 或 ZIP 服务端包");
        const upload = new FormData();
        upload.append("file", file);
        const result = await api<{ artifact: { id: string } }>(
          "/api/artifacts",
          { method: "POST", body: upload },
        );
        artifactId = result.artifact.id;
      }
      await api("/api/instances", {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          nodeId: data.get("nodeId"),
          kind,
          version: data.get("version"),
          memoryMb: Number(data.get("memory")),
          cpuCores: Number(data.get("cpu")),
          diskMb: Number(data.get("disk")),
          pids: 512,
          artifactId,
          customJar: data.get("customJar") || undefined,
          eulaAccepted: data.get("eula") === "on",
        }),
      });
      await refresh();
      onClose();
      notify("实例创建任务已提交");
    } catch (error) {
      notify(error instanceof Error ? error.message : "实例未创建");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="创建 Minecraft 实例" onClose={onClose}>
      {nodes.length ? (
        <form className="dialog-form" onSubmit={submit}>
          <label>
            实例名称
            <input name="name" required placeholder="survival-01" />
          </label>
          <div className="two-inputs">
            <label>
              节点
              <select name="nodeId" required>
                {nodes.map((node) => (
                  <option value={node.id} key={node.id}>
                    {node.name}
                    {node.online ? "" : "（离线，任务将排队）"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              服务端
              <select
                name="kind"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                <option value="paper">Paper</option>
                <option value="vanilla">Vanilla Java</option>
                <option value="fabric">Fabric</option>
                <option value="forge">Forge</option>
                <option value="bedrock">Bedrock</option>
                <option value="custom">自定义包</option>
              </select>
            </label>
          </div>
          {kind === "custom" && (
            <>
              <label>
                服务端包
                <input
                  name="artifact"
                  type="file"
                  accept=".jar,.zip,application/java-archive,application/zip"
                  required
                />
              </label>
              <label>
                入口 JAR
                <input
                  name="customJar"
                  placeholder="ZIP 包默认使用 server.jar"
                />
              </label>
            </>
          )}
          <div className="two-inputs">
            <label>
              版本
              <input name="version" defaultValue="1.21.4" required />
            </label>
            <label>
              内存 MB
              <input
                name="memory"
                type="number"
                defaultValue="2048"
                min="512"
              />
            </label>
          </div>
          <div className="two-inputs">
            <label>
              vCPU
              <input
                name="cpu"
                type="number"
                step="0.25"
                defaultValue="1"
                min="0.25"
              />
            </label>
            <label>
              磁盘 MB
              <input
                name="disk"
                type="number"
                defaultValue="10240"
                min="1024"
              />
            </label>
          </div>
          <label className="check-row">
            <input name="eula" type="checkbox" required />
            我已阅读并同意 Mojang EULA
          </label>
          <button className="button primary" disabled={busy}>
            {busy && <LoaderCircle size={16} className="spin" />}创建实例
          </button>
        </form>
      ) : (
        <Empty icon={<Network size={24} />} title="请先添加节点" />
      )}
    </Dialog>
  );
}

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="dialog-head">
          <h3>{title}</h3>
          <button className="icon-button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function Status({
  value,
  status,
}: {
  value: string;
  status: Instance["status"] | Task["status"];
}) {
  return (
    <span className={`status ${statusClass(status)}`}>
      <i />
      {value}
    </span>
  );
}
function Empty({
  icon,
  title,
  action,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty">
      <span>{icon}</span>
      <p>{title}</p>
      {action && (
        <button className="button compact" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}
