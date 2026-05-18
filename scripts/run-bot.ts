import { initBot, runBot } from "../src/bot/bot.js";
import { createFileLogger } from "../src/logger.js";

const log = createFileLogger("run-bot");
log.info(`Writing bot logs to: ${log.filePath}`);

try {
  const ctx = initBot(log);
  await runBot(log, ctx);
} catch (error) {
  log.error("Bot execution failed:", error);
  process.exitCode = 1;
} finally {
  await log.close();
}

