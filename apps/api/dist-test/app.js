import Fastify from "fastify";
export function createApp(_environment) {
    const app = Fastify({ logger: false });
    app.get("/health/live", async () => ({ status: "ok" }));
    return app;
}
