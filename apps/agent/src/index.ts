import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import type { AgentInboundMessage, AgentOutboundMessage, AgentTask, NodeUsage } from "@micopanel/protocol";
import { loadConfig } from "./config.js";
import { DockerRuntime } from "./runtime.js";

interface Credentials {
  nodeId: string;
  certificate: string;
}

const config = loadConfig();
const credentialsPath = resolve(config.DATA_ROOT, "agent-credentials.json");

const loadCredentials = async (): Promise<Credentials | undefined> => {
  try { return JSON.parse(await readFile(credentialsPath, "utf8")) as Credentials; } catch { return undefined; }
};

const saveCredentials = async (credentials: Credentials): Promise<void> => {
  await mkdir(config.DATA_ROOT, { recursive: true });
  await writeFile(credentialsPath, JSON.stringify(credentials), { mode: 0o600 });
};

const wsUrl = (controllerUrl: string): string => {
  const url = new URL(controllerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws/agent`;
  return url.toString();
};

class Agent {
  private socket?: WebSocket;
  private credentials?: Credentials;
  private retryDelay = 1000;
  private taskChain = Promise.resolve();
  private heartbeat?: NodeJS.Timeout;
  private readonly runtime = new DockerRuntime(config.DOCKER_SOCKET, config.DATA_ROOT, (instanceId, line) => this.send({ type: "console.output", instanceId, line }), config.s3, config.CONTROLLER_URL);

  async start(): Promise<void> {
    await this.runtime.init();
    this.credentials = await loadCredentials();
    this.connect();
  }

  private connect(): void {
    const socket = new WebSocket(wsUrl(config.CONTROLLER_URL));
    this.socket = socket;
    socket.on("open", () => {
      this.retryDelay = 1000;
      if (this.credentials) {
        this.send({ type: "authenticate", ...this.credentials, agentVersion: config.AGENT_VERSION, capabilities: ["docker", "console", "files", "backups", "metrics"] });
      } else if (config.ENROLLMENT_TOKEN) {
        this.send({ type: "register", token: config.ENROLLMENT_TOKEN, nodeName: config.NODE_NAME, agentVersion: config.AGENT_VERSION, capabilities: ["docker", "console", "files", "backups", "metrics"] });
      } else {
        socket.close(4403, "missing credentials and enrollment token");
      }
      this.heartbeat = setInterval(() => void this.sendHeartbeat(), 5000);
      void this.sendHeartbeat();
    });
    socket.on("message", (raw) => void this.handle(JSON.parse(raw.toString()) as AgentOutboundMessage));
    socket.on("close", () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
    });
    socket.on("error", () => socket.close());
  }

  private send(message: AgentInboundMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      const usage: NodeUsage = await this.runtime.usage();
      this.send({ type: "heartbeat", usage });
    } catch {
      // Docker can transiently restart; the following heartbeat will recover the state.
    }
  }

  private async handle(message: AgentOutboundMessage): Promise<void> {
    if (message.type === "registered") {
      this.credentials = { nodeId: message.nodeId, certificate: message.certificate };
      await saveCredentials(this.credentials);
      return;
    }
    if (message.type === "error") {
      console.error(`[micopanel-agent] ${message.message}`);
      return;
    }
    if (message.type === "task") {
      this.taskChain = this.taskChain.then(() => this.runTask(message.task)).catch((error) => console.error(error));
    }
  }

  private async runTask(task: AgentTask): Promise<void> {
    this.send({ type: "task.ack", taskId: task.id });
    try {
      this.send({ type: "task.progress", taskId: task.id, message: "正在执行", progress: 10 });
      const result = await this.runtime.execute(task);
      this.send({ type: "task.result", taskId: task.id, ok: true, message: result.message, data: result.data });
    } catch (error) {
      this.send({ type: "task.result", taskId: task.id, ok: false, message: error instanceof Error ? error.message : "Unknown agent error" });
    }
  }
}

void new Agent().start();
