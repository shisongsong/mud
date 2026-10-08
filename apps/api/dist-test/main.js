import { createApp } from "./app.js";
import { loadEnvironment } from "./config/env.js";
const environment = loadEnvironment();
const app = createApp(environment);
try {
    await app.listen({ host: environment.HOST, port: environment.PORT });
}
catch (error) {
    app.log.error(error);
    process.exitCode = 1;
}
