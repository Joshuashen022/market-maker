import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Log } from "../logger.js";
import type { BotContext } from "../bot/bot.js";

function getNowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function createApiRouter(log: Log, bot: BotContext): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      nowSec: getNowSec(),
      pools: bot.poolManager.pools.length,
    });
  });

  router.get("/price", async (req, res, next) => {
    try {
      const indexRaw = typeof req.query.index === "string" ? req.query.index : "0";
      const index = Number(indexRaw);
      if (!Number.isInteger(index) || index < 0) {
        res.status(400).json({ ok: false, error: "Invalid index" });
        return;
      }

      const p = await bot.poolManager.getPrice(index);
      res.json({
        ok: true,
        poolIndex: index,
        poolAddress: p.poolAddress,
        fee: p.fee,
        token0: p.token0,
        token1: p.token1,
        sqrtPriceX96: p.sqrtPriceX96.toString(),
        num1Per0: p.num1Per0.toString(),
        den1Per0: p.den1Per0.toString(),
        num0Per1: p.num0Per1.toString(),
        den0Per1: p.den0Per1.toString(),
      });
    } catch (e) {
      next(e);
    }
  });
  
  router.post("/swap2", async (req, res, next) => {
    try {
      const { isBuy, amountInERC20, price, walletIdx, slippage, poolIndex} = req.body;
      await bot.poolManager.swap2(isBuy, amountInERC20, price, walletIdx, slippage, poolIndex);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.get("/anchor/latest", (_req, res) => {
    res.json({ ok: true, latest: bot.anchor.latest() });
  });

  router.get("/anchor/twap", async (req, res, next) => {
    try {
      const nowSecRaw = typeof req.query.nowSec === "string" ? req.query.nowSec : undefined;
      const nowSec = nowSecRaw ? Number(nowSecRaw) : getNowSec();
      if (!Number.isFinite(nowSec) || nowSec <= 0) {
        res.status(400).json({ ok: false, error: "Invalid nowSec" });
        return;
      }
      const twap = await bot.anchor.twap(Math.floor(nowSec));
      res.json({ ok: true, nowSec: Math.floor(nowSec), twapTokenPerEth: twap });
    } catch (e) {
      next(e);
    }
  });

  // Minimal error handler (keeps stack out of responses by default).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("[api] request error:", err);
    res.status(500).json({ ok: false, error: msg });
  });

  return router;
}

