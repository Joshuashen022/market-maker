import express from "express";
import type { Log } from "../logger.js";
import { initBot, runBot, type BotContext } from "../bot/bot.js";
import { createApiRouter } from "./router.js";

export type ApiServer = {
  app: express.Express;
  bot: BotContext;
  botLoop: Promise<void>;
};

export function createApiServer(log: Log): ApiServer {
  const bot = initBot(log);

  // Start the bot loop "in the background" (do not await).
  const botLoop = runBot(log, bot).catch((err) => {
    log.error("[api] bot loop crashed:", err);
    throw err;
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  // Mount API routes (add new endpoints inside src/api/router.ts).
  app.use("/", createApiRouter(log, bot));

  return { app, bot, botLoop };
}

