import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { registerAuthRoutes, } from "./server/auth-routes.js";
import { readSessionSecret } from "./server/auth-routes.js";
import { registerPlayerRoutes, } from "./server/player-routes.js";
import { registerGameplayRoutes, } from "./server/gameplay-routes.js";
import { registerQueryRoutes, } from "./server/query-routes.js";
import { registerPlayRoutes } from "./server/play-routes.js";
import { isSameOriginRequest } from "./server/origin.js";
import { registerBoardRoutes, } from "./server/board-routes.js";
export function createApp(_environment, dependencies = {}) {
    const app = Fastify({ logger: false });
    registerPlayRoutes(app);
    app.get("/health/live", async () => ({ status: "ok" }));
    app.get("/health/ready", async (_request, reply) => {
        if (!dependencies.checkReadiness) {
            return reply.code(503).send({ status: "not_ready" });
        }
        try {
            await dependencies.checkReadiness();
            return { status: "ok" };
        }
        catch {
            return reply.code(503).send({ status: "not_ready" });
        }
    });
    const auth = dependencies.auth;
    if (auth) {
        app.addHook("preHandler", async (request, reply) => {
            if (request.method === "GET" ||
                request.method === "HEAD" ||
                request.method === "OPTIONS" ||
                request.url.startsWith("/auth/")) {
                return;
            }
            if (!isSameOriginRequest(request, auth.publicOrigin, auth.allowHostOriginFallback ?? false)) {
                const traceId = randomUUID();
                return reply.code(403).send({
                    code: "ORIGIN_REJECTED",
                    messageKey: "auth.originRejected",
                    args: {},
                    traceId,
                });
            }
            try {
                const csrfToken = request.headers["x-csrf-token"];
                const valid = await auth.identity.validateCsrf(readSessionSecret(request, auth.secureCookies), typeof csrfToken === "string" ? csrfToken : null);
                if (!valid) {
                    const traceId = randomUUID();
                    return reply.code(403).send({
                        code: "CSRF_REJECTED",
                        messageKey: "auth.csrfRejected",
                        args: {},
                        traceId,
                    });
                }
            }
            catch {
                const traceId = randomUUID();
                return reply.code(503).send({
                    code: "AUTH_UNAVAILABLE",
                    messageKey: "auth.unavailable",
                    args: {},
                    traceId,
                });
            }
        });
    }
    if (dependencies.auth) {
        registerAuthRoutes(app, dependencies.auth);
    }
    if (dependencies.players) {
        registerPlayerRoutes(app, dependencies.players);
    }
    if (dependencies.gameplay) {
        registerGameplayRoutes(app, dependencies.gameplay);
    }
    if (dependencies.queries) {
        registerQueryRoutes(app, dependencies.queries);
    }
    if (dependencies.board) {
        registerBoardRoutes(app, dependencies.board);
    }
    return app;
}
