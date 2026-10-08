import { z } from "zod";
const envSchema = z
    .object({
    NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_URL: z.string().url().optional(),
    DATABASE_SSL_CA_FILE: z.string().min(1).optional(),
    REDIS_URL: z.string().url().default("redis://127.0.0.1:6379"),
    PUBLIC_ORIGIN: z.string().url().optional(),
})
    .superRefine((environment, context) => {
    if (environment.NODE_ENV !== "production")
        return;
    if (!environment.PUBLIC_ORIGIN) {
        context.addIssue({
            code: "custom",
            path: ["PUBLIC_ORIGIN"],
            message: "PUBLIC_ORIGIN is required in production",
        });
        return;
    }
    const origin = new URL(environment.PUBLIC_ORIGIN);
    if (origin.protocol !== "https:") {
        context.addIssue({
            code: "custom",
            path: ["PUBLIC_ORIGIN"],
            message: "PUBLIC_ORIGIN must use HTTPS in production",
        });
    }
    if (origin.origin !== environment.PUBLIC_ORIGIN.replace(/\/$/, "")) {
        context.addIssue({
            code: "custom",
            path: ["PUBLIC_ORIGIN"],
            message: "PUBLIC_ORIGIN must contain only an origin, without a path",
        });
    }
});
export function loadEnvironment(source = process.env) {
    return envSchema.parse(source);
}
