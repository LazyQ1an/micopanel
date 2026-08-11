import { z } from "zod";

const schema = z.object({
  CONTROLLER_URL: z.string().url(),
  ENROLLMENT_TOKEN: z.string().min(20).optional(),
  NODE_NAME: z.string().min(2).max(64).default("minecraft-node"),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  DATA_ROOT: z.string().default("/var/lib/micopanel"),
  AGENT_VERSION: z.string().default("0.1.0"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().min(3).max(255).optional(),
  S3_REGION: z.string().default("auto"),
  S3_ACCESS_KEY_ID: z.string().min(3).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(8).optional()
});

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type AgentConfig = z.infer<typeof schema> & { s3?: S3Config };

export const loadConfig = (): AgentConfig => {
  const config = schema.parse(process.env);
  const provided = [config.S3_ENDPOINT, config.S3_BUCKET, config.S3_ACCESS_KEY_ID, config.S3_SECRET_ACCESS_KEY].filter(Boolean).length;
  if (provided > 0 && provided < 4) throw new Error("S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY must be configured together");
  if (provided === 4) {
    return {
      ...config,
      s3: {
        endpoint: config.S3_ENDPOINT!,
        bucket: config.S3_BUCKET!,
        region: config.S3_REGION,
        accessKeyId: config.S3_ACCESS_KEY_ID!,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY!
      }
    };
  }
  return config;
};
