import { z } from "zod";
const envSchema = z.object({
    NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    SQL_SERVER: z.string().default("localhost"),
    SQL_PORT: z.coerce.number().int().min(1).max(65_535).default(1433),
    SQL_DATABASE: z.string().default("mud"),
    SQL_USER: z.string().optional(),
    SQL_PASSWORD: z.string().optional(),
    SQL_ENCRYPT: z.stringbool().default(true),
    SQL_TRUST_SERVER_CERTIFICATE: z.stringbool().default(false),
    REDIS_URL: z.string().url().default("redis://127.0.0.1:6379"),
});
export function loadEnvironment(source = process.env) {
    return envSchema.parse(source);
}
