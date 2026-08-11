import type { InstanceSpec, ServerKind } from "@micopanel/protocol";

export interface ServerTemplate {
  kind: ServerKind;
  label: string;
  description: string;
  image: string;
  defaultPort: number;
  protocol: "tcp" | "udp";
  environment: Record<string, string>;
}

export const SERVER_TEMPLATES: ServerTemplate[] = [
  {
    kind: "vanilla",
    label: "Vanilla Java",
    description: "原版 Java 服务端，适合纯净生存与红石玩法。",
    image: "itzg/minecraft-server:java21",
    defaultPort: 25565,
    protocol: "tcp",
    environment: { TYPE: "VANILLA", EULA: "TRUE" }
  },
  {
    kind: "paper",
    label: "Paper",
    description: "高性能 Bukkit 兼容服务端，适合插件服。",
    image: "itzg/minecraft-server:java21",
    defaultPort: 25565,
    protocol: "tcp",
    environment: { TYPE: "PAPER", EULA: "TRUE" }
  },
  {
    kind: "fabric",
    label: "Fabric",
    description: "轻量模组加载器，适合高自由度模组服。",
    image: "itzg/minecraft-server:java21",
    defaultPort: 25565,
    protocol: "tcp",
    environment: { TYPE: "FABRIC", EULA: "TRUE" }
  },
  {
    kind: "forge",
    label: "Forge",
    description: "经典模组生态，支持大型整合包。",
    image: "itzg/minecraft-server:java21",
    defaultPort: 25565,
    protocol: "tcp",
    environment: { TYPE: "FORGE", EULA: "TRUE" }
  },
  {
    kind: "bedrock",
    label: "Bedrock",
    description: "基岩版专用服务端，默认使用 UDP。",
    image: "itzg/minecraft-bedrock-server",
    defaultPort: 19132,
    protocol: "udp",
    environment: { EULA: "TRUE", VERSION: "LATEST" }
  },
  {
    kind: "custom",
    label: "自定义服务端",
    description: "上传自己的 JAR 或服务端包，使用受控运行时。",
    image: "eclipse-temurin:21-jre",
    defaultPort: 25565,
    protocol: "tcp",
    environment: { EULA: "TRUE" }
  }
];

export const getTemplate = (kind: ServerKind): ServerTemplate => {
  const template = SERVER_TEMPLATES.find((candidate) => candidate.kind === kind);
  if (!template) throw new Error(`Unsupported server kind: ${kind}`);
  return template;
};

export const publicInstance = (instance: InstanceSpec & { ownerId?: string; console?: string[]; files?: Record<string, string> }) => {
  const { ownerId: _ownerId, console: _console, files: _files, ...safe } = instance;
  return safe;
};

