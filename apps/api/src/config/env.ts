import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_SSL_CA_FILE: z.string().min(1).optional(),
  REDIS_URL: z.string().url().default("redis://127.0.0.1:6379"),
});

export type AppEnvironment = z.infer<typeof envSchema>;

export function loadEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): AppEnvironment {
  return envSchema.parse(source);
}
