import { z } from "zod";

const schema = z.object({
  CONTROLLER_URL: z.string().url(),
  ENROLLMENT_TOKEN: z.string().min(20).optional(),
  NODE_NAME: z.string().min(2).max(64).default("minecraft-node"),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  DATA_ROOT: z.string().default("/var/lib/micopanel"),
  AGENT_VERSION: z.string().default("0.1.0")
});

export type AgentConfig = z.infer<typeof schema>;
export const loadConfig = (): AgentConfig => schema.parse(process.env);

