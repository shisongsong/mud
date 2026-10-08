import { createApp } from "./app.ts";
import { loadEnvironment } from "./config/env.ts";

const environment = loadEnvironment();
const app = createApp(environment);

try {
  await app.listen({ host: environment.HOST, port: environment.PORT });
} catch (error: unknown) {
  app.log.error(error);
  process.exitCode = 1;
}
