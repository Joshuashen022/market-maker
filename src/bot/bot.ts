import "dotenv/config";
import { JsonRpcProvider, Wallet, parseEther, parseUnits } from "ethers";
import { PoolManager, PoolPriceResult, formatRational } from "./pool-manager.js";
import { defaultConfig, loadConfig } from "./config.js";
import { AnchorPrice, type PriceSample } from "./anchor.js";
import { StrategyState } from "./strategy.js";
import { calculatePrices } from "../v3-utils.js";
import { WalletRotator } from "./wallet-rotator.js";
import type { Log } from "../logger.js";
import { getProvider } from "./get-provider.js";
const DRY_RUN = process.env.DRY_RUN || false;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function toUnitsFloat(value: number, decimals: number | string): bigint {
  if (!Number.isFinite(value)) throw new Error(`Invalid numeric value: ${value}`);
  if (value < 0) throw new Error(`Negative value not allowed: ${value}`);
  const dec = typeof decimals === "number" ? decimals : Number(decimals);
  if (!Number.isInteger(dec) || dec < 0 || dec > 255) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  // Use string-based parsing to avoid JS float * 10**decimals precision issues.
  // Keep at most `decimals` fractional digits.
  const s = value.toFixed(dec);
  return parseUnits(s, dec);
}

function isEthToken(t: { symbol: string; name: string }): boolean {
  const sym = (t.symbol ?? "").toUpperCase();
  if (sym === "ETH" || sym === "WETH") return true;
  const name = (t.name ?? "").toLowerCase();
  return name.includes("ether");
}

/** Build PriceSample from pool prices. priceTokenPerEth = TOKEN per 1 ETH. */
function priceResultToSample(erc20EthPrice: PoolPriceResult, log: Log): PriceSample {
  // Pool 0: ERC20 <-> ETH. We want "non-ETH token per 1 ETH".
  const priceTokenPerEth = calculatePrices(erc20EthPrice.sqrtPriceX96.toString(), Number(erc20EthPrice.token0.decimals), Number(erc20EthPrice.token1.decimals)).token0PerToken1;
  // log.log("priceTokenPerEth", priceTokenPerEth);
  // Pool 1: ETH <-> USDT (or other USD stable). We want USD per 1 ETH.
  // const ethUsd = calculatePrices(ethUsdtPrice.sqrtPriceX96.toString(), Number(ethUsdtPrice.token0.decimals), Number(ethUsdtPrice.token1.decimals)).token0PerToken1;
  // console.log("ethUsd", ethUsd);
  return { t: nowSec(), priceTokenPerEth: Number(priceTokenPerEth)};
}

export type BotContext = {
  cfg: ReturnType<typeof defaultConfig>;
  provider: JsonRpcProvider;
  poolManager: PoolManager;
  anchor: AnchorPrice;
  strat: StrategyState;
};

export function initBot(log: Log): BotContext {
  const cfg = defaultConfig();
  const provider = getProvider(cfg.rpcUrl);
  const poolManager = PoolManager.load(log, provider);
  const anchor = new AnchorPrice(cfg, poolManager, log);
  anchor.trackPrice().catch((err) => {
    log.error("AnchorPrice.trackPrice failed:", err);
    throw err;
  });
  const strat = new StrategyState(cfg);
  return { cfg, provider, poolManager, anchor, strat };
}

export async function runBot(log: Log, ctx: BotContext) {
  const { cfg, provider, poolManager, anchor, strat } = ctx;

  while (true) {
    const currentTime = nowSec();
    const price = await anchor.twap(currentTime); // Token(0) amount per 1 wETH(1)
    const decision = strat.decide(
      { nowSec: currentTime, spotTokenPerEth: price, anchorTokenPerEth: price }
    );
    const walletRotator = new WalletRotator(provider, cfg.maxConsecutivePerWallet);
    const w = walletRotator.pickRandom();
    walletRotator.markUsed(w);
    const chosenWallet = w.wallet;

    const amountInERC20 = decision.amountERC20;
    const amountInEth = amountInERC20 / price;

    const isBuy = decision.side === "BUY";
    log.log(
      `[SWAP2] price=${price?.toFixed(6)} WETH amount=${amountInEth.toFixed(6)} slip=${(decision.slippage * 100).toFixed(
        2
      )}% delay=${decision.nextDelaySec}s wallet=${chosenWallet.address} isBuy=${isBuy} amountInERC20=${amountInERC20} `
    );
    await poolManager.swap2(isBuy, amountInERC20, price, w.idx, decision.slippage, 0);

    if (DRY_RUN) {
      await sleep(1000);
    } else {
      await sleep(decision.nextDelaySec * 1000);
    }
  }
}


