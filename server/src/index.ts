import http from "node:http";
import { config } from "./config.js";
import { db } from "./db/db.js";
import { createApp } from "./app.js";
import { attachEvents } from "./lib/events.js";
import { startWorker } from "./jobs/queue.js";
import { log } from "./lib/logger.js";
import { startWatcher } from "./services/realtime.js";
import { startAdvisoryWatch } from "./services/advisories.js";

db(); // open + migrate
const server = http.createServer(createApp());
attachEvents(server);
startWorker();
startWatcher();
startAdvisoryWatch();
server.listen(config.port, () => {
  log.info(`DevForge AI API listening on http://localhost:${config.port}`, { dataDir: config.dataDir, env: config.env });
});

const shutdown = () => {
  log.info("Shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
