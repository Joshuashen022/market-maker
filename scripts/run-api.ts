import "dotenv/config";
import { createFileLogger } from "../src/logger.js";
import { createApiServer } from "../src/api/server.js";

const log = createFileLogger("run-api");
log.info(`Writing api logs to: ${log.filePath}`);

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
if (!Number.isInteger(port) || port <= 0) {
  log.error("Invalid PORT:", process.env.PORT);
  process.exitCode = 1;
  await log.close();
  throw new Error("Invalid PORT");
}

try {
  const { app } = createApiServer(log);
  const server = app.listen(port, () => {
    log.info(`[api] listening on :${port}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`[api] received ${signal}, shutting down`);

    // Ensure we exit even if background loops are still running.
    const forceExit = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error("[api] force exit after timeout");
      process.exit(1);
    }, 2_500);
    forceExit.unref();

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await log.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
} catch (error) {
  log.error("API execution failed:", error);
  process.exitCode = 1;
  await log.close();
}

