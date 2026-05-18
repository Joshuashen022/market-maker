import express from "express";
import type { Log } from "../logger.js";
import { initBot, runBot, type BotContext } from "../bot/bot.js";
import { createApiRouter } from "./router.js";

export type ApiServer = {
  app: express.Express;
  botCtx: BotContext;
};

export function createApiServer(log: Log): ApiServer {
  const bot = initBot(log);

  // Start the bot loop "in the background" (do not await).
  startBotLoop(log, bot).catch((err) => {
    log.error("[api] bot loop crashed:", err);
    throw err;
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  // Mount API routes (add new endpoints inside src/api/router.ts).
  app.use("/", createApiRouter(log, bot));

  return { app, botCtx: bot };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startBotLoop(log: Log, bot: BotContext) {
  while (true) {
    try {
      await runBot(log, bot);
    } catch (err) {
      log.error("[api] bot loop crashed:", err);
      await sleep(1000);
    }
  }
}