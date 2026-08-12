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
  Eye,
  EyeOff,
  FileCode2,
  FilePlus2,
  Folder,
  FolderTree,
  Gauge,
  HardDrive,
  KeyRound,
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
  useRef,
  useState,
} from "react";
import { api, ApiError, formatBytes, formatTime } from "./api";
import type {
  ApiToken,
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


function useAnimatedNumber(value: number, duration = 550): number {
  const [display, setDisplay] = useState(value);
  const previous = useRef(value);
  useEffect(() => {
    const from = previous.current;
    const to = value;
    if (from === to) return;
    previous.current = value;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, value]);
  return display;
}

type Screen =
  "overview" | "instances" | "nodes" | "tasks" | "backups" | "audit" | "users";
type Modal = "node" | "instance" | null;
type DetailTab = "console" | "metrics" | "config" | "files" | "backups" | "schedules" | "members";
type Toast = { text: string; tone: "success" | "error" };

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
    { id: "users", label: "用户", icon: ShieldCheck },
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
  return (
    <ControlPanel
      user={status.user}
      onSignOut={refresh}
      onUserUpdated={(next) =>
        setStatus((current) =>
          current ? { ...current, user: next } : current,
        )
      }
    />
  );
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
  const [twoFactor, setTwoFactor] = useState<{
    username: string;
    password: string;
  }>();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const username = String(data.get("username") ?? "");
    const password = String(data.get("password") ?? "");
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user?: User; twoFactorRequired?: boolean }>(
        `/api/auth/${mode === "setup" ? "bootstrap" : "login"}`,
        {
          method: "POST",
          body: JSON.stringify({ username, password }),
        },
      );
      if (mode === "login" && result.twoFactorRequired) {
        setTwoFactor({ username, password });
        return;
      }
      await onComplete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法完成登录");
    } finally {
      setBusy(false);
    }
  };
  const submitCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!twoFactor) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: twoFactor.username,
          password: twoFactor.password,
          code: data.get("code"),
        }),
      });
      await onComplete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法完成登录");
    } finally {
      setBusy(false);
    }
  };
  const challenge = mode === "login" && twoFactor;
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
        {challenge ? (
          <form className="auth-form" onSubmit={submitCode}>
            <p className="eyebrow">Two-factor authentication</p>
            <h2>输入两步验证码</h2>
            <p className="auth-hint">
              账号 {twoFactor.username} 已开启两步验证，请输入身份验证器中的 6
              位动态码，或使用一次性恢复码。
            </p>
            <label>
              验证码
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                minLength={6}
                required
                placeholder="6 位动态码"
              />
            </label>
            {error && (
              <p className="form-error">
                <CircleAlert size={16} /> {error}
              </p>
            )}
            <button className="button primary full" type="submit" disabled={busy}>
              {busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <ChevronRight size={17} />
              )}
              验证并登录
            </button>
            <button
              className="auth-back"
              type="button"
              onClick={() => setTwoFactor(undefined)}
            >
              返回重新输入密码
            </button>
          </form>
        ) : (
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
            <button className="button primary full" type="submit" disabled={busy}>
              {busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <ChevronRight size={17} />
              )}
              {mode === "setup" ? "创建并进入面板" : "登录"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

function ControlPanel({
  user,
  onSignOut,
  onUserUpdated,
}: {
  user: User;
  onSignOut: () => Promise<void>;
  onUserUpdated: (user: User) => void;
}) {
  const [screen, setScreen] = useState<Screen>("overview");
  const [panelOpen, setPanelOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [detail, setDetail] = useState<InstanceDetail>();
  const [modal, setModal] = useState<Modal>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    run: () => Promise<void>;
  }>();
  const [toast, setToast] = useState<Toast>();
  const [audit, setAudit] = useState<
    Array<{
      id: string;
      action: string;
      target: string;
      detail?: string;
      createdAt: string;
    }>
  >([]);

  const notify = useCallback(
    (message?: string, tone: Toast["tone"] = "success") => {
      if (message) setToast({ text: message, tone });
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await api<Dashboard>("/api/dashboard");
      setDashboard(next);
      setSelectedId((current) =>
        current && next.instances.some((instance) => instance.id === current)
          ? current
          : next.instances[0]?.id,
      );
      setSelectedNodeId((current) =>
        current && next.nodes.some((node) => node.id === current)
          ? current
          : next.nodes[0]?.id,
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法刷新控制面", "error");
    }
  }, []);

  const refreshDetail = useCallback(async (instanceId: string) => {
    try {
      setDetail(await api<InstanceDetail>(`/api/instances/${instanceId}`));
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法加载实例", "error");
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
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selected = dashboard?.instances.find(
    (instance) => instance.id === selectedId,
  );
  const action = async (
    instance: Instance,
    name: "start" | "stop" | "restart" | "kill" | "command",
    command?: string,
  ) => {
    if (name === "kill") {
      setConfirm({
        title: "强制停止实例",
        body: `确定强制停止 “${instance.name}” 吗？未保存的数据可能丢失，且无法通过常规停止流程恢复。`,
        confirmLabel: "强制停止",
        run: async () => {
          try {
            await api(`/api/instances/${instance.id}/actions`, {
              method: "POST",
              body: JSON.stringify({ action: name, command }),
            });
            notify(`${instance.name}：强制停止任务已提交`);
            void refresh();
          } catch (error) {
            notify(
              error instanceof Error ? error.message : "操作未完成",
              "error",
            );
          }
        },
      });
      return;
    }
    try {
      await api(`/api/instances/${instance.id}/actions`, {
        method: "POST",
        body: JSON.stringify({ action: name, command }),
      });
      notify(`${instance.name}：任务已提交`);
      void refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "操作未完成", "error");
    }
  };
  const retryTask = async (task: Task) => {
    try {
      await api(`/api/tasks/${task.id}/retry`, { method: "POST" });
      notify(`${task.type}：重试任务已提交`);
      void refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "任务未能重新提交", "error");
    }
  };
  const deleteNode = (node: Node) => {
    setConfirm({
      title: "删除节点",
      body: `确定删除节点 “${node.name}” 吗？删除前需先归档或迁移该节点上的全部实例，此操作无法撤销。`,
      confirmLabel: "删除节点",
      run: async () => {
        try {
          await api(`/api/nodes/${node.id}`, { method: "DELETE" });
          notify(`节点 ${node.name} 已删除`);
          void refresh();
        } catch (error) {
          notify(
            error instanceof Error ? error.message : "节点未删除",
            "error",
          );
        }
      },
    });
  };
  const signOut = async () => {
    await api("/api/auth/logout", { method: "POST" });
    await onSignOut();
  };
  const loadAudit = async () => {
    try {
      setAudit((await api<{ audits: typeof audit }>("/api/audit")).audits);
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法读取审计记录", "error");
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
          {nav
            .filter((item) => item.id !== "users" || user.role === "admin")
            .map(({ id, label, icon: Icon }) => (
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
            title="安全设置"
            onClick={() => setSecurityOpen(true)}
          >
            <Settings2 size={18} />
          </button>
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
            {user.role === "admin" && screen !== "users" && (
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
          <div className="page-loading skeleton-loading">
            <span className="skeleton-loading-title">
              <LoaderCircle className="spin" size={16} /> 正在载入运行状态
            </span>
            <div className="skeleton-metrics">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="skeleton" />
              ))}
            </div>
            <div className="skeleton-panels">
              <div className="skeleton" />
              <div className="skeleton" />
            </div>
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
              <Nodes
                nodes={dashboard.nodes}
                selectedId={selectedNodeId}
                onSelect={setSelectedNodeId}
                canViewMetrics={user.role === "admin"}
                onNew={() => setModal("node")}
                onDelete={deleteNode}
              />
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
            {screen === "users" && (
              <UsersScreen
                currentUserId={user.id}
                admin={user.role === "admin"}
                notify={notify}
              />
            )}
            {screen === "instances" && selected && (
              <InstanceWorkspace
                key={selected.id}
                detail={detail}
                instance={selected}
                node={dashboard.nodes.find((node) => node.id === selected.nodeId)}
                onAction={action}
                notify={notify}
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
          notify={notify}
        />
      )}
      {modal === "instance" && dashboard && (
        <InstanceModal
          nodes={dashboard.nodes}
          onClose={() => setModal(null)}
          refresh={refresh}
          notify={notify}
        />
      )}
      {securityOpen && (
        <SecurityDialog
          user={user}
          onClose={() => setSecurityOpen(false)}
          notify={notify}
          onUserUpdated={onUserUpdated}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          onConfirm={confirm.run}
          onCancel={() => setConfirm(undefined)}
        />
      )}
      <div className="toast-stack">
        {toast && (
          <button
            className={`toast ${toast.tone === "error" ? "error" : ""}`}
            onClick={() => setToast(undefined)}
          >
            {toast.tone === "error" ? (
              <CircleAlert size={16} />
            ) : (
              <Check size={16} />
            )}
            <span>{toast.text}</span>
            <X size={15} />
          </button>
        )}
      </div>
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
          count={dashboard.summary.runningInstances}
          suffix={`/ ${dashboard.summary.totalInstances}`}
          icon={<Power size={19} />}
          tone="mint"
        />
        <Metric
          label="在线节点"
          value={`${dashboard.summary.onlineNodes}`}
          count={dashboard.summary.onlineNodes}
          suffix={`/ ${dashboard.summary.totalNodes}`}
          icon={<Network size={19} />}
          tone="forest"
        />
        <Metric
          label="待执行任务"
          value={String(dashboard.summary.queuedTasks)}
          count={dashboard.summary.queuedTasks}
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
              hint="接入第一台服务器，从这里掌控全局"
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
  count,
  suffix,
  icon,
  tone,
}: {
  label: string;
  value: string;
  count?: number;
  suffix?: string;
  icon: ReactNode;
  tone: string;
}) {
  const animated = useAnimatedNumber(count ?? 0);
  const display = typeof count === "number" ? String(animated) : value;
  return (
    <section className={`metric ${tone}`}>
      <span className="metric-icon">{icon}</span>
      <p>{label}</p>
      <strong>
        {display}
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
          hint="试试切换上方的筛选条件"
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

const nodeLoadLevel = (node: Node): "high" | "critical" | undefined => {
  if (!node.usage) return undefined;
  const cpu = node.usage.cpuPercent ?? 0;
  const memoryPercent = node.usage.memoryLimitBytes ? (node.usage.memoryBytes / node.usage.memoryLimitBytes) * 100 : 0;
  if (cpu >= 95 || memoryPercent >= 95) return "critical";
  if (cpu >= 80 || memoryPercent >= 85) return "high";
  return undefined;
};

function Nodes({ nodes, selectedId, onSelect, canViewMetrics, onNew, onDelete }: { nodes: Node[]; selectedId?: string; onSelect: (id: string) => void; canViewMetrics: boolean; onNew: () => void; onDelete: (node: Node) => void }) {
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
            <article className={`node-card ${selectedId === node.id ? "selected" : ""} ${nodeLoadLevel(node) ? `load-${nodeLoadLevel(node)}` : ""}`} key={node.id}>
              <div className="node-card-top">
                <span className={`dot large ${node.online ? "online" : ""}`} />
                <div>
                  <h4>{node.name}</h4>
                  <p>{node.online ? "Agent 已连接" : "等待 Agent 注册"}</p>
                </div>
                {nodeLoadLevel(node) && (
                  <span
                    className={`node-load ${nodeLoadLevel(node)}`}
                    title={`CPU ${Math.round(node.usage?.cpuPercent ?? 0)}% · 内存 ${Math.round(node.usage?.memoryLimitBytes ? (node.usage.memoryBytes / node.usage.memoryLimitBytes) * 100 : 0)}%`}
                  >
                    {nodeLoadLevel(node) === "critical" ? "过载" : "高负载"}
                  </span>
                )}
                <Status
                  value={node.online ? "在线" : "离线"}
                  status={node.online ? "running" : "offline"}
                />
                {canViewMetrics && (
                  <button
                    className="icon-button node-health-trigger"
                    title="查看节点健康趋势"
                    aria-label={`查看 ${node.name} 节点健康趋势`}
                    aria-pressed={selectedId === node.id}
                    onClick={() => onSelect(node.id)}
                  >
                    <Gauge size={16} />
                  </button>
                )}
                {canViewMetrics && (
                  <button
                    className="icon-button node-delete-trigger"
                    title="删除节点"
                    aria-label={`删除 ${node.name} 节点`}
                    onClick={() => onDelete(node)}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
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
          hint="添加一台机器作为节点，部署你的 Minecraft 服务器"
          action="添加节点"
          onAction={onNew}
        />
      )}
      {canViewMetrics && selectedId && nodes.some((node) => node.id === selectedId) && (
        <NodeHealth node={nodes.find((node) => node.id === selectedId)!} />
      )}
    </section>
  );
}

function NodeHealth({ node }: { node: Node }) {
  const [minutes, setMinutes] = useState(60);
  const [points, setPoints] = useState<MetricPoint[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await api<{ metrics: MetricPoint[] }>(`/api/nodes/${node.id}/metrics?minutes=${minutes}`);
        if (active) {
          setPoints(result.metrics);
          setError(undefined);
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "节点健康数据暂时无法读取");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [node.id, minutes]);

  const latest = points[points.length - 1];
  const diskBytes = latest?.diskBytes ?? node.usage?.diskBytes;
  const diskLimitBytes = latest?.diskLimitBytes ?? node.usage?.diskLimitBytes;
  const diskPercent = diskBytes !== undefined && diskLimitBytes ? (diskBytes / diskLimitBytes) * 100 : 0;
  const risk = diskPercent >= 90 ? "error" : diskPercent >= 75 ? "starting" : "running";
  return (
    <div className="node-health-tool">
      <div className="node-health-head">
        <div>
          <span className="tool-kicker">NODE HEALTH</span>
          <strong>{node.name} · 容量与趋势</strong>
        </div>
        <Status value={diskLimitBytes ? `磁盘 ${diskPercent.toFixed(0)}%` : "等待采样"} status={diskLimitBytes ? risk : "offline"} />
      </div>
      <div className="metrics-toolbar">
        <span>时间范围</span>
        {[15, 60, 360, 1440].map((range) => (
          <button key={range} type="button" className={minutes === range ? "selected" : ""} onClick={() => setMinutes(range)}>
            {range < 60 ? `${range} 分钟` : range === 60 ? "1 小时" : range === 360 ? "6 小时" : "24 小时"}
          </button>
        ))}
      </div>
      <div className="metrics-summary node-health-summary">
        <MetricReadout label="CPU" value={latest ? `${latest.cpuPercent.toFixed(1)}%` : node.usage ? `${node.usage.cpuPercent.toFixed(1)}%` : "--"} />
        <MetricReadout label="内存" value={latest ? `${formatBytes(latest.memoryBytes)} / ${formatBytes(latest.memoryLimitBytes)}` : node.usage ? `${formatBytes(node.usage.memoryBytes)} / ${formatBytes(node.usage.memoryLimitBytes)}` : "--"} />
        <MetricReadout label="磁盘" value={diskBytes !== undefined ? `${formatBytes(diskBytes)} / ${formatBytes(diskLimitBytes)}` : "--"} />
        <MetricReadout label="网络 RX / TX" value={latest ? `${formatBytes(latest.networkRxBytes)} / ${formatBytes(latest.networkTxBytes)}` : "--"} />
      </div>
      {error ? <p className="metric-error">{error}</p> : null}
      <div className="metric-charts node-health-charts">
        <MetricChart title="CPU 使用率" points={points.map((point) => point.cpuPercent)} suffix="%" color="#56d59b" max={100} />
        <MetricChart title="内存占用" points={points.map((point) => point.memoryBytes)} suffix="" color="#e4b45b" max={Math.max(1, ...points.map((point) => point.memoryLimitBytes))} format={formatBytes} />
        <MetricChart title="磁盘占用" points={points.map((point) => point.diskBytes ?? 0)} suffix="" color="#c780d9" max={Math.max(1, ...points.map((point) => point.diskLimitBytes ?? 0))} format={formatBytes} />
        <MetricChart title="网络 RX" points={points.map((point) => point.networkRxBytes)} suffix="" color="#7bb7e8" max={Math.max(1, ...points.map((point) => point.networkRxBytes))} format={formatBytes} />
      </div>
      {!points.length && !error ? <p className="metric-empty">节点在线并上报后，会在这里显示容量趋势。</p> : null}
    </div>
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
  onRestore,
}: {
  backups: Backup[];
  instances: Instance[];
  onRestore?: (backup: Backup) => void;
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
              {onRestore && backup.status === "available" && (
                <button
                  className="button compact"
                  title="用此备份覆盖实例数据并重启"
                  onClick={() => onRestore(backup)}
                >
                  <ArchiveRestore size={14} /> 恢复
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <Empty icon={<DatabaseBackup size={24} />} title="还没有备份归档"
          hint="对实例执行一次备份，数据就有了第一道防线" />
      )}
    </section>
  );
}


function UsersScreen({
  currentUserId,
  admin,
  notify,
}: {
  currentUserId: string;
  admin: boolean;
  notify: (message?: string, tone?: "success" | "error") => void;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);
  const [resetFor, setResetFor] = useState<string>();
  const [newPassword, setNewPassword] = useState("");
  const [pending, setPending] = useState<User>();

  const load = useCallback(async () => {
    try {
      setUsers((await api<{ users: User[] }>("/api/users")).users);
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "无法读取用户列表",
        "error",
      );
    }
  }, [notify]);

  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);

  const lastAdmin = (user: User) =>
    user.role === "admin" &&
    users.filter((candidate) => candidate.role === "admin").length <= 1;

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({
          username: data.get("username"),
          password: data.get("password"),
          role: data.get("role"),
        }),
      });
      form.reset();
      await load();
      notify("账号已创建");
    } catch (error) {
      notify(error instanceof Error ? error.message : "账号未创建", "error");
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (user: User, role: "admin" | "user") => {
    if (role === user.role) return;
    if (role === "user" && lastAdmin(user)) {
      notify("必须保留至少一名管理员", "error");
      return;
    }
    setBusy(true);
    try {
      await api(`/api/users/${user.id}`, {
        method: "PUT",
        body: JSON.stringify({ role }),
      });
      await load();
      notify(`${user.username} 的角色已更新`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "角色未更新", "error");
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async (user: User) => {
    if (newPassword.length < 10) return;
    setBusy(true);
    try {
      await api(`/api/users/${user.id}`, {
        method: "PUT",
        body: JSON.stringify({ password: newPassword }),
      });
      setResetFor(undefined);
      setNewPassword("");
      await load();
      notify(`已重置 ${user.username} 的密码，其会话已全部注销`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "密码未重置", "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (user: User) => {
    setBusy(true);
    try {
      await api(`/api/users/${user.id}`, { method: "DELETE" });
      setPending(undefined);
      await load();
      notify(`账号 ${user.username} 已删除`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "账号未删除", "error");
    } finally {
      setBusy(false);
    }
  };

  if (!admin)
    return (
      <section className="panel">
        <Empty
          icon={<ShieldCheck size={24} />}
          title="用户管理仅向管理员开放"
        />
      </section>
    );

  return (
    <section className="panel table-panel users-panel">
      <div className="panel-heading table-heading">
        <div>
          <p className="eyebrow">Access control</p>
          <h3>用户与角色</h3>
        </div>
        <button
          className="icon-button"
          title="刷新用户列表"
          onClick={() => void load()}
        >
          <RotateCcw size={16} />
        </button>
      </div>
      <form className="user-create-form" onSubmit={create}>
        <span className="user-create-title">
          <Plus size={15} /> 创建账号
        </span>
        <label>
          用户名
          <input
            name="username"
            minLength={3}
            maxLength={32}
            required
            placeholder="builder"
          />
        </label>
        <label>
          初始密码
          <input
            name="password"
            type="password"
            minLength={10}
            required
            placeholder="至少 10 位"
          />
        </label>
        <label>
          角色
          <select name="role" defaultValue="user">
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <button className="button compact primary" type="submit" disabled={busy}>
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Plus size={15} />
          )}
          创建
        </button>
      </form>
      <div className="user-table">
        <div className="table-row table-head user-row-head">
          <span>账号</span>
          <span>角色</span>
          <span>创建时间</span>
          <span>操作</span>
        </div>
        {users.map((user) => {
          const self = user.id === currentUserId;
          const protectedAdmin = lastAdmin(user);
          return (
            <div className="table-row user-row" key={user.id}>
              <span className="user-identity">
                <b>{user.username.slice(0, 1).toUpperCase()}</b>
                <strong>
                  {user.username}
                  {self && <small>当前账号</small>}
                </strong>
              </span>
              <span>
                <select
                  className="user-role-select"
                  value={user.role}
                  disabled={busy || self || protectedAdmin}
                  title={
                    self
                      ? "不能修改当前登录账号的角色"
                      : protectedAdmin
                        ? "必须保留至少一名管理员"
                        : "修改角色"
                  }
                  onChange={(event) =>
                    void changeRole(
                      user,
                      event.target.value as "admin" | "user",
                    )
                  }
                >
                  <option value="admin">管理员</option>
                  <option value="user">普通用户</option>
                </select>
              </span>
              <span className="user-created">
                <time>{formatTime(user.createdAt)}</time>
              </span>
              <span className="user-actions">
                {resetFor === user.id ? (
                  <>
                    <input
                      className="user-password-input"
                      type="password"
                      autoFocus
                      minLength={10}
                      placeholder="新密码，至少 10 位"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                    />
                    <button
                      className="button compact primary"
                      disabled={busy || newPassword.length < 10}
                      onClick={() => void resetPassword(user)}
                    >
                      确认
                    </button>
                    <button
                      className="icon-button"
                      title="取消重置"
                      disabled={busy}
                      onClick={() => {
                        setResetFor(undefined);
                        setNewPassword("");
                      }}
                    >
                      <X size={15} />
                    </button>
                  </>
                ) : (
                  <button
                    className="icon-button"
                    title={
                      self ? "不能重置当前登录账号的密码" : "重置密码"
                    }
                    disabled={busy || self}
                    onClick={() => {
                      setResetFor(user.id);
                      setNewPassword("");
                    }}
                  >
                    <Pencil size={15} />
                  </button>
                )}
                <button
                  className="icon-button action-bad"
                  title={self ? "不能删除当前登录账号" : "删除账号"}
                  disabled={busy || self || protectedAdmin}
                  onClick={() => setPending(user)}
                >
                  <Trash2 size={15} />
                </button>
              </span>
            </div>
          );
        })}
        {!users.length && <p className="quiet user-empty">暂无账号</p>}
      </div>
      {pending && (
        <ConfirmDialog
          title="删除账号"
          body={`确定删除账号 “${pending.username}” 吗？该账号的全部会话将立即注销，且无法恢复。`}
          confirmLabel="删除"
          onConfirm={() => remove(pending)}
          onCancel={() => setPending(undefined)}
        />
      )}
    </section>
  );
}

const auditLabels: Record<string, string> = {
  "auth.bootstrap": "初始化控制面",
  "auth.login": "登录",
  "auth.login.challenged": "等待两步验证",
  "auth.password_changed": "修改密码",
  "auth.2fa.provisioned": "生成两步验证密钥",
  "auth.2fa.enabled": "开启两步验证",
  "auth.2fa.disabled": "关闭两步验证",
  "token.created": "创建 API 令牌",
  "token.revoked": "吊销 API 令牌",
  "token.expired": "令牌到期失效",
  "auth.login.failed": "登录失败",
  "auth.2fa.failed": "两步验证失败",
  "user.created": "创建用户",
  "user.deleted": "删除用户",
  "user.password_reset": "重置用户密码",
  "user.role.updated": "调整用户角色",
  "node.created": "创建节点",
  "node.deleted": "删除节点",
  "instance.created": "创建实例",
  "instance.archived": "归档实例",
  "instance.restored": "恢复实例",
  "instance.config.updated": "更新实例配置",
  "instance.member.added": "添加协作者",
  "instance.member.removed": "移除协作者",
  "instance.member.updated": "更新协作者权限",
  "file.write": "写入文件",
  "file.upload.queued": "排队上传文件",
  "file.download.queued": "排队下载文件",
  "backup.created": "创建备份",
  "backup.restore.requested": "请求恢复备份",
  "schedule.created": "创建调度任务",
  "schedule.updated": "更新调度任务",
  "schedule.deleted": "删除调度任务",
  "task.retry.requested": "重试任务",
  "artifact.uploaded": "上传服务器包",
  agent: "Agent 连接",
  system: "系统事件"
};

const auditCategories: Array<{ label: string; actions: string[] }> = [
  {
    label: "认证与安全",
    actions: [
      "auth.bootstrap",
      "auth.login",
      "auth.login.challenged",
      "auth.password_changed",
      "auth.2fa.provisioned",
      "auth.2fa.enabled",
      "auth.2fa.disabled",
      "token.created",
      "token.revoked",
      "token.expired",
      "auth.login.failed",
      "auth.2fa.failed"
    ]
  },
  {
    label: "用户",
    actions: [
      "user.created",
      "user.deleted",
      "user.password_reset",
      "user.role.updated"
    ]
  },
  {
    label: "节点与实例",
    actions: [
      "node.created",
      "node.deleted",
      "instance.created",
      "instance.archived",
      "instance.restored",
      "instance.config.updated",
      "instance.member.added",
      "instance.member.removed",
      "instance.member.updated"
    ]
  },
  {
    label: "文件与备份",
    actions: [
      "file.write",
      "file.upload.queued",
      "file.download.queued",
      "backup.created",
      "backup.restore.requested"
    ]
  },
  {
    label: "调度与任务",
    actions: ["schedule.created", "schedule.updated", "schedule.deleted", "task.retry.requested"]
  },
  {
    label: "系统",
    actions: ["agent", "artifact.uploaded", "system"]
  }
];

function Audit({
  events,
  allow,
}: {
  events: Array<{
    id: string;
    action: string;
    target: string;
    detail?: string;
    ip?: string;
    userAgent?: string;
    createdAt: string;
  }>;
  allow: boolean;
}) {
  const [category, setCategory] = useState("全部");
  if (!allow)
    return (
      <section className="panel">
        <Empty
          icon={<ShieldCheck size={24} />}
          title="审计记录仅向管理员开放"
        />
      </section>
    );
  const filtered =
    category === "全部"
      ? events
      : events.filter(
          (event) =>
            auditCategories
              .find((group) => group.label === category)
              ?.actions.includes(event.action) ?? false,
        );
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Security trail</p>
          <h3>操作审计</h3>
        </div>
        <span className="audit-count">{filtered.length} 条</span>
      </div>
      <div className="audit-filters">
        <button
          className={category === "全部" ? "active" : ""}
          onClick={() => setCategory("全部")}
        >
          全部
        </button>
        {auditCategories.map((group) => (
          <button
            key={group.label}
            className={category === group.label ? "active" : ""}
            onClick={() => setCategory(group.label)}
          >
            {group.label}
          </button>
        ))}
      </div>
      {filtered.length ? (
        <div className="audit-list">
          {filtered.map((event) => (
            <div className="audit-row" key={event.id}>
              <ShieldCheck size={17} />
              <span>
                <strong>{auditLabels[event.action] ?? event.action}</strong>
                <small>
                  <code>{event.action}</code> {event.target}
                  {event.detail ? ` · ${event.detail}` : ""}
                </small>
                {event.ip ? (
                  <span className="audit-meta" title={event.userAgent ?? undefined}>
                    {event.ip}
                    {event.userAgent ? ` · ${event.userAgent.length > 60 ? `${event.userAgent.slice(0, 60)}…` : event.userAgent}` : ""}
                  </span>
                ) : null}
              </span>
              <time>{formatTime(event.createdAt)}</time>
            </div>
          ))}
        </div>
      ) : (
        <p className="quiet">该分类下暂无审计记录。</p>
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
  notify: (message?: string, tone?: "success" | "error") => void;
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
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<Backup>();
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
            "error",
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
      notify(error instanceof Error ? error.message : "无法读取文件", "error");
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
      notify(error instanceof Error ? error.message : "无法打开文件", "error");
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
      notify(error instanceof Error ? error.message : "文件未保存", "error");
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
      notify(error instanceof Error ? error.message : "文件未上传", "error");
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
      notify(error instanceof Error ? error.message : "无法准备下载文件", "error");
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
      notify(error instanceof Error ? error.message : "备份任务未完成", "error");
    }
  };
  const archived = instance.status === "archived";
  const archiveInstance = async () => {
    try {
      const result = await api<{ recoverUntil: string }>(
        `/api/instances/${instance.id}`,
        { method: "DELETE" },
      );
      setConfirmArchive(false);
      notify(`实例已归档，可在 ${formatTime(result.recoverUntil)} 前恢复`);
      reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : "实例未归档", "error");
    }
  };
  const restoreInstance = async () => {
    try {
      await api(`/api/instances/${instance.id}/restore`, { method: "POST" });
      notify("实例恢复任务已提交");
      reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : "实例未恢复", "error");
    }
  };
  const restoreBackup = async () => {
    if (!restoreTarget) return;
    try {
      await api(
        `/api/instances/${instance.id}/backups/${restoreTarget.id}/restore`,
        { method: "POST" },
      );
      setRestoreTarget(undefined);
      notify(`备份 “${restoreTarget.name}” 恢复任务已提交`);
      reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : "备份恢复未完成", "error");
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
              archived ||
              instance.status === "running" ||
              instance.status === "starting"
            }
            onClick={() => void onAction(instance, "start")}
          >
            <Play size={17} />
          </button>
          <button
            className="icon-button"
            title="重启"
            disabled={archived}
            onClick={() => void onAction(instance, "restart")}
          >
            <RotateCcw size={17} />
          </button>
          <button
            className="icon-button action-warn"
            title="停止"
            disabled={archived || instance.status === "offline"}
            onClick={() => void onAction(instance, "stop")}
          >
            <Pause size={17} />
          </button>
          <button
            className="icon-button action-bad"
            title="强制停止"
            disabled={archived}
            onClick={() => void onAction(instance, "kill")}
          >
            <Power size={17} />
          </button>
          <button
            className={`icon-button ${archived ? "action-good" : "action-warn"}`}
            title={archived ? "恢复实例" : "归档实例"}
            onClick={() => {
              if (archived) void restoreInstance();
              else setConfirmArchive(true);
            }}
          >
            <ArchiveRestore size={17} />
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
            <Backups
              backups={detail.backups}
              instances={[instance]}
              onRestore={setRestoreTarget}
            />
          ) : (
            <p className="quiet">创建备份后可在此查看归档状态。</p>
          )}
        </div>
      )}
      {archived && (
        <div className="archived-banner">
          <ArchiveRestore size={16} />
          <span>
            实例已归档，数据保留至{" "}
            {instance.archiveExpiresAt
              ? formatTime(instance.archiveExpiresAt)
              : "7 天"}
            。恢复后即可重新分配并启动。
          </span>
          <button className="button compact primary" onClick={() => void restoreInstance()}>
            立即恢复
          </button>
        </div>
      )}
      {confirmArchive && (
        <ConfirmDialog
          title="归档实例"
          body={`确定归档实例 “${instance.name}” 吗？实例将停止并从节点移除，数据保留 7 天，期间可随时恢复。`}
          confirmLabel="归档"
          onConfirm={archiveInstance}
          onCancel={() => setConfirmArchive(false)}
        />
      )}
      {restoreTarget && (
        <ConfirmDialog
          title="恢复备份"
          body={`确定用备份 “${restoreTarget.name}” 覆盖实例 “${instance.name}” 的当前数据吗？实例将停止、数据被替换并自动重启。`}
          confirmLabel="恢复备份"
          onConfirm={restoreBackup}
          onCancel={() => setRestoreTarget(undefined)}
        />
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
        <MetricReadout
          label="CPU"
          value={latest ? `${latest.cpuPercent.toFixed(1)}%` : "--"}
          count={latest?.cpuPercent}
          format={(value) => `${value.toFixed(1)}%`}
        />
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

function MetricReadout({
  label,
  value,
  count,
  format,
}: {
  label: string;
  value: string;
  count?: number;
  format?: (value: number) => string;
}) {
  const animated = useAnimatedNumber(count ?? 0);
  const display = typeof count === "number" ? (format ? format(animated) : String(animated)) : value;
  return <div className="metric-readout"><small>{label}</small><strong>{display}</strong></div>;
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
          <path d={path} pathLength={1} style={{ stroke: color }} />
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
  notify: (message?: string, tone?: "success" | "error") => void;
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
      notify(error instanceof Error ? error.message : "计划任务未保存", "error");
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
      notify(error instanceof Error ? error.message : "计划任务状态未更新", "error");
    } finally {
      setBusy(false);
    }
  };
  const [confirmRemove, setConfirmRemove] = useState<Schedule>();
  const remove = (schedule: Schedule) => setConfirmRemove(schedule);
  const confirmDelete = async () => {
    if (!confirmRemove) return;
    setBusy(true);
    try {
      await api(`/api/instances/${instance.id}/schedules/${confirmRemove.id}`, { method: "DELETE" });
      if (editing?.id === confirmRemove.id) reset();
      notify("计划任务已删除");
      reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : "计划任务未删除", "error");
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
      {confirmRemove && (
        <ConfirmDialog
          title="删除计划任务"
          body={`确定删除计划任务 “${confirmRemove.name}” 吗？该操作不可撤销。`}
          confirmLabel="删除"
          onConfirm={confirmDelete}
          onCancel={() => setConfirmRemove(undefined)}
        />
      )}
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
  notify: (message?: string, tone?: "success" | "error") => void;
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
      notify("请先确认将重建运行容器", "error");
      return;
    }
    const nextEnvironment: Record<string, string> = {};
    for (const entry of environment) {
      const key = entry.key.trim();
      if (!key) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        notify("环境变量名称只能包含字母、数字和下划线", "error");
        return;
      }
      if (key in nextEnvironment) {
        notify("环境变量名称不能重复", "error");
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
      notify(error instanceof Error ? error.message : "实例配置未保存", "error");
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
          <button className="button primary" type="submit" disabled={saving || !confirmed}>
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
  notify: (message?: string, tone?: "success" | "error") => void;
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
      notify(error instanceof Error ? error.message : "无法读取协作者", "error");
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
      notify(error instanceof Error ? error.message : "协作者未保存", "error");
    } finally {
      setBusy(false);
    }
  };

  const createAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
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
      form.reset();
      await load();
      setSelectedUserId(result.user.id);
      notify("本地账号已创建");
    } catch (error) {
      notify(error instanceof Error ? error.message : "账号未创建", "error");
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
  notify: (message?: string, tone?: "success" | "error") => void;
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
    } catch (error) { notify(error instanceof Error ? error.message : "权限未更新", "error"); }
    finally { setSaving(false); }
  };
  const [confirmRemove, setConfirmRemove] = useState(false);
  const remove = () => setConfirmRemove(true);
  const confirmDelete = async () => {
    setSaving(true);
    try {
      await api(`/api/instances/${instanceId}/members/${member.userId}`, { method: "DELETE" });
      notify("协作者已移除");
      await onSaved();
    } catch (error) { notify(error instanceof Error ? error.message : "协作者未移除", "error"); }
    finally { setSaving(false); }
  };
  return <article className="member-row collaborator-row">
    <span className="member-avatar">{member.user.username.slice(0, 1).toUpperCase()}</span>
    <span className="member-identity"><strong>{member.user.username}</strong><small>{member.user.role === "admin" ? "管理员账号" : "本地账号"}</small></span>
    <div className="member-permissions"><PermissionChecklist value={permissions} onChange={setPermissions} disabled={!canManage || saving || busy} /></div>
    {canManage && <div className="member-row-actions"><button className="icon-button" title="保存权限" disabled={saving || busy || !permissions.length} onClick={() => void save()}><Save size={15} /></button><button className="icon-button action-bad" title="移除协作者" disabled={saving || busy} onClick={() => void remove()}><Trash2 size={15} /></button></div>}
    {confirmRemove && (
      <ConfirmDialog
        title="移除协作者"
        body={`确定移除 ${member.user.username} 对该实例的全部权限吗？`}
        confirmLabel="移除"
        onConfirm={confirmDelete}
        onCancel={() => setConfirmRemove(false)}
      />
    )}
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
  notify: (message?: string, tone?: "success" | "error") => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      notify("复制失败，请手动选择令牌文本", "error");
    }
  };
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
      notify(error instanceof Error ? error.message : "节点未创建", "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="添加受管节点" onClose={onClose}>
      {token ? (
        <div className="enrollment">
          <ShieldCheck size={28} />
          <p>仅显示一次的注册令牌，请妥善保存</p>
          <div className="token-reveal">
            <code>{revealed ? token : "••••••••••••••••••••••••••••••••"}</code>
            <button
              className="icon-button"
              title={revealed ? "隐藏令牌" : "显示令牌"}
              onClick={() => setRevealed((value) => !value)}
            >
              {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <button className="button" onClick={() => void copyToken()}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? "已复制" : "复制令牌"}
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
          <button className="button primary" type="submit" disabled={busy}>
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
  notify: (message?: string, tone?: "success" | "error") => void;
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
      notify(error instanceof Error ? error.message : "实例未创建", "error");
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
          <button className="button primary" type="submit" disabled={busy}>
            {busy && <LoaderCircle size={16} className="spin" />}创建实例
          </button>
        </form>
      ) : (
        <Empty icon={<Network size={24} />} title="请先添加节点"
          hint="创建实例至少需要一个可用节点" />
      )}
    </Dialog>
  );
}

function TokenExpiryBadge({ expiresAt }: { expiresAt?: string }) {
  if (!expiresAt) return <span className="token-expiry none">永久</span>;
  const remaining = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (remaining <= 0) return <span className="token-expiry expired">已过期</span>;
  if (remaining <= 7) return <span className="token-expiry warn">剩余 {remaining} 天</span>;
  return <span className="token-expiry ok">剩余 {remaining} 天</span>;
}

function SecurityDialog({
  user,
  onClose,
  notify,
  onUserUpdated,
}: {
  user: User;
  onClose: () => void;
  notify: (message?: string, tone?: "success" | "error") => void;
  onUserUpdated: (user: User) => void;
}) {
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [totpBusy, setTotpBusy] = useState(false);
  const [totp, setTotp] = useState<{
    secret: string;
    qrDataUrl: string;
    otpauthUrl: string;
  }>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>();
  const [disableCode, setDisableCode] = useState("");
  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    const confirmPassword = String(data.get("confirmPassword") ?? "");
    if (newPassword !== confirmPassword) {
      notify("两次输入的新密码不一致", "error");
      return;
    }
    setPasswordBusy(true);
    try {
      await api("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      notify("密码已更新，其他设备已退出登录");
      form.reset();
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "密码修改失败",
        "error",
      );
    } finally {
      setPasswordBusy(false);
    }
  };
  const provision = async () => {
    setTotpBusy(true);
    try {
      const result = await api<{
        secret: string;
        qrDataUrl: string;
        otpauthUrl: string;
      }>("/api/auth/2fa/provision", { method: "POST" });
      setTotp(result);
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "无法生成两步验证密钥",
        "error",
      );
    } finally {
      setTotpBusy(false);
    }
  };
  const enable = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!totp) return;
    const data = new FormData(event.currentTarget);
    setTotpBusy(true);
    try {
      const result = await api<{ recoveryCodes: string[]; user: User }>(
        "/api/auth/2fa/enable",
        {
          method: "POST",
          body: JSON.stringify({ code: data.get("code") }),
        },
      );
      setRecoveryCodes(result.recoveryCodes);
      onUserUpdated(result.user);
      notify("两步验证已开启");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "两步验证开启失败",
        "error",
      );
    } finally {
      setTotpBusy(false);
    }
  };
  const disable = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTotpBusy(true);
    try {
      await api("/api/auth/2fa/disable", {
        method: "POST",
        body: JSON.stringify({ code: disableCode }),
      });
      setDisableCode("");
      setTotp(undefined);
      onUserUpdated({ ...user, twoFactorEnabled: false });
      notify("两步验证已关闭");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "两步验证关闭失败",
        "error",
      );
    } finally {
      setTotpBusy(false);
    }
  };
  const [apiTokens, setApiTokens] = useState<ApiToken[]>([]);
  const [tokenName, setTokenName] = useState("");
  const [tokenDays, setTokenDays] = useState(30);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [createdToken, setCreatedToken] = useState<string>();
  const loadTokens = async () => {
    try {
      const result = await api<{ apiTokens: ApiToken[] }>("/api/tokens");
      setApiTokens(result.apiTokens);
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法读取 API 令牌", "error");
    }
  };
  useEffect(() => {
    void loadTokens();
  }, []);
  const createToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = tokenName.trim();
    if (!name || tokenBusy) return;
    setTokenBusy(true);
    try {
      const result = await api<{ token: string }>("/api/tokens", {
        method: "POST",
        body: JSON.stringify(tokenDays > 0 ? { name, days: tokenDays } : { name }),
      });
      setCreatedToken(result.token);
      setTokenName("");
      await loadTokens();
    } catch (error) {
      notify(error instanceof Error ? error.message : "令牌创建失败", "error");
    } finally {
      setTokenBusy(false);
    }
  };
  const revokeToken = async (token: ApiToken) => {
    setTokenBusy(true);
    try {
      await api(`/api/tokens/${token.id}`, { method: "DELETE" });
      notify(`令牌 “${token.name}” 已吊销`);
      setApiTokens((current) => current.filter((item) => item.id !== token.id));
    } catch (error) {
      notify(error instanceof Error ? error.message : "令牌吊销失败", "error");
    } finally {
      setTokenBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="dialog security-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="安全设置"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <h3>
            <ShieldCheck size={18} /> 安全设置
          </h3>
          <button className="icon-button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="security-sections">
          <section className="security-section">
            <div className="security-head">
              <h4>修改密码</h4>
              <span className="security-state">已启用</span>
            </div>
            <p className="security-note">
              修改后其他设备的会话将立即失效，请妥善保管新密码。
            </p>
            <form className="security-form" onSubmit={changePassword}>
              <label>
                当前密码
                <input
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
              <label>
                新密码
                <input
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  required
                  placeholder="至少 10 个字符"
                />
              </label>
              <label>
                确认新密码
                <input
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  required
                />
              </label>
              <button
                className="button primary"
                type="submit"
                disabled={passwordBusy}
              >
                {passwordBusy && <LoaderCircle size={16} className="spin" />}
                更新密码
              </button>
            </form>
          </section>
          <section className="security-section">
            <div className="security-head">
              <h4>两步验证（TOTP）</h4>
              <span
                className={`security-state ${
                  user.twoFactorEnabled ? "on" : "off"
                }`}
              >
                {user.twoFactorEnabled ? "已开启" : "未开启"}
              </span>
            </div>
            {!user.twoFactorEnabled && !totp && !recoveryCodes && (
              <>
                <p className="security-note">
                  开启后登录需要输入身份验证器中的 6
                  位动态码，显著降低账号被盗风险。
                </p>
                <button
                  className="button"
                  onClick={() => void provision()}
                  disabled={totpBusy}
                >
                  {totpBusy && <LoaderCircle size={16} className="spin" />}
                  开启两步验证
                </button>
              </>
            )}
            {!user.twoFactorEnabled && totp && !recoveryCodes && (
              <div className="totp-setup">
                <p className="security-note">
                  使用身份验证器（Google Authenticator、Microsoft
                  Authenticator、1Password 等）扫描二维码，或手动输入密钥。
                </p>
                <img
                  className="totp-qr"
                  src={totp.qrDataUrl}
                  alt="两步验证二维码"
                />
                <code className="totp-secret">{totp.secret}</code>
                <form className="security-form" onSubmit={enable}>
                  <label>
                    6 位动态码
                    <input
                      name="code"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      required
                      placeholder="输入身份验证器中的验证码"
                    />
                  </label>
                  <button
                    className="button primary"
                    type="submit"
                    disabled={totpBusy}
                  >
                    {totpBusy && <LoaderCircle size={16} className="spin" />}
                    验证并开启
                  </button>
                </form>
              </div>
            )}
            {recoveryCodes && (
              <div className="recovery-codes">
                <p className="security-note">
                  请立即保存这些恢复码。每个恢复码只能使用一次，用于手机丢失时登录。
                </p>
                <div className="recovery-grid">
                  {recoveryCodes.map((code) => (
                    <code key={code}>{code}</code>
                  ))}
                </div>
                <button
                  className="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(
                      recoveryCodes.join("\n"),
                    );
                    notify("恢复码已复制到剪贴板");
                  }}
                >
                  <Copy size={16} /> 复制全部恢复码
                </button>
              </div>
            )}
            {user.twoFactorEnabled && !recoveryCodes && (
              <div className="totp-enabled">
                <p className="security-note">
                  两步验证已开启。关闭需要输入当前动态码或一条未使用的恢复码。
                </p>
                <form className="security-form" onSubmit={disable}>
                  <label>
                    动态码或恢复码
                    <input
                      value={disableCode}
                      onChange={(event) => setDisableCode(event.target.value)}
                      required
                      placeholder="6 位动态码或恢复码"
                    />
                  </label>
                  <button
                    className="button danger"
                    type="submit"
                    disabled={totpBusy || !disableCode.trim()}
                  >
                    {totpBusy && <LoaderCircle size={16} className="spin" />}
                    关闭两步验证
                  </button>
                </form>
              </div>
            )}
          </section>
          <section className="security-section">
            <div className="security-head">
              <h4>
                <KeyRound size={16} /> API 访问令牌
              </h4>
              <span className="security-state">
                {apiTokens.length ? `${apiTokens.length} 个` : "未创建"}
              </span>
            </div>
            <p className="security-note">
              令牌用于脚本与自动化工具调用控制面 API，通过{" "}
              <code>Authorization: Bearer &lt;token&gt;</code>{" "}
              认证。令牌明文只在创建时显示一次，请立即保存。
            </p>
            {createdToken && (
              <div className="token-created">
                <span>新令牌已创建（仅显示一次）{tokenDays > 0 ? `，有效期 ${tokenDays} 天` : ""}</span>
                <code>{createdToken}</code>
                <button
                  className="button compact"
                  onClick={() => {
                    void navigator.clipboard?.writeText(createdToken);
                    notify("令牌已复制到剪贴板");
                  }}
                >
                  <Copy size={14} /> 复制令牌
                </button>
                <button
                  className="icon-button"
                  title="关闭"
                  onClick={() => setCreatedToken(undefined)}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            <form className="security-form token-create" onSubmit={createToken}>
              <label>
                令牌名称
                <input
                  value={tokenName}
                  onChange={(event) => setTokenName(event.target.value)}
                  maxLength={64}
                  required
                  placeholder="例如：ci-deploy、备份脚本"
                />
              </label>
              <label>
                有效期
                <select
                  value={tokenDays}
                  onChange={(event) => setTokenDays(Number(event.target.value))}
                >
                  <option value={7}>7 天</option>
                  <option value={30}>30 天</option>
                  <option value={90}>90 天</option>
                  <option value={365}>365 天</option>
                  <option value={0}>永不过期</option>
                </select>
              </label>
              <button
                className="button"
                type="submit"
                disabled={tokenBusy || !tokenName.trim()}
              >
                {tokenBusy && <LoaderCircle size={16} className="spin" />}
                <Plus size={16} /> 创建令牌
              </button>
            </form>
            {apiTokens.length ? (
              <div className="token-list">
                {apiTokens.map((token) => (
                  <div className="token-row" key={token.id}>
                    <KeyRound size={16} />
                    <span>
                      <strong>{token.name}</strong>
                      <small>
                        创建于 {formatTime(token.createdAt)}
                        {token.lastUsedAt
                          ? ` · 最近使用 ${formatTime(token.lastUsedAt)}`
                          : " · 尚未使用"}
                        {token.expiresAt ? ` · 到期 ${formatTime(token.expiresAt)}` : ""}
                      </small>
                    </span>
                    <TokenExpiryBadge expiresAt={token.expiresAt} />
                    <button
                      className="icon-button danger"
                      title="吊销令牌"
                      disabled={tokenBusy}
                      onClick={() => void revokeToken(token)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="quiet">尚未创建 API 令牌。</p>
            )}
          </section>
        </div>
      </section>
    </div>
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
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      onCancel();
    }
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="dialog confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="confirm-icon">
          <CircleAlert size={22} />
        </div>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="confirm-actions">
          <button className="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            className="button danger"
            onClick={() => void confirm()}
            disabled={busy}
          >
            {busy && <LoaderCircle size={16} className="spin" />}
            {confirmLabel}
          </button>
        </div>
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
  hint,
  action,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty">
      <span>{icon}</span>
      <p>{title}</p>
      {hint && <small>{hint}</small>}
      {action && (
        <button className="button compact" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}
