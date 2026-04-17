import { createApp } from "./app";
import { startCostAgentAutopilot } from "./automation/cost-agent.autopilot";
import { env } from "./config/env";
import { startEventBus } from "./events/bus";
import { logger, scoped } from "./lib/logger";

const log = scoped("startup");
const app = createApp();

startEventBus();
startCostAgentAutopilot();

app.listen(env.API_PORT, () => {
  log.info({ port: env.API_PORT }, `api listening on ${env.API_PORT}`);
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaughtException");
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "unhandledRejection");
});
