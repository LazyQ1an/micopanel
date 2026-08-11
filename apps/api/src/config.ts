import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().url().optional(),
  SESSION_SECRET: z.string().min(24).default("development-session-secret-change-before-production"),
  APP_ENCRYPTION_KEY: z.string().min(24).default("development-encryption-key-change-before-production"),
  BOOTSTRAP_USERNAME: z.string().min(3).max(32).default("admin"),
  BOOTSTRAP_PASSWORD: z.string().min(10).default("ChangeMe123!"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  ARTIFACTS_DIR: z.string().default("./data/artifacts"),
  ARTIFACT_MAX_BYTES: z.coerce.number().int().positive().max(2 * 1024 * 1024 * 1024).default(1024 * 1024 * 1024),
  ARTIFACT_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().max(1440).default(60)
});

export type AppConfig = z.infer<typeof schema>;

export const loadConfig = (): AppConfig => {
  const config = schema.parse(process.env);
  if (config.NODE_ENV === "production") {
    if (!config.DATABASE_URL) throw new Error("DATABASE_URL is required in production");
    if (config.SESSION_SECRET.includes("development-")) throw new Error("Set a unique SESSION_SECRET in production");
    if (config.APP_ENCRYPTION_KEY.includes("development-")) throw new Error("Set a unique APP_ENCRYPTION_KEY in production");
  }
  return config;
};
