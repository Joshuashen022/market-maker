import "dotenv/config";
import { JsonRpcProvider, Wallet, parseEther, parseUnits } from "ethers";
import { PoolManager, PoolPriceResult, formatRational } from "./pool-manager.js";
import { defaultConfig, loadConfig } from "./config.js";
import { AnchorPrice, type PriceSample } from "./anchor.js";
import { StrategyState } from "./strategy.js";
import { calculatePrices } from "../v3-utils.js";
import { WalletRotator } from "./wallet-rotator.js";
import type { Log } from "../logger.js";
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


export async function runBot(log: Log) {
  const cfg = defaultConfig();
  const provider = new JsonRpcProvider(cfg.rpcUrl);
  const poolManager = PoolManager.load(log, provider);

  const anchor = new AnchorPrice(cfg, poolManager, log);
  const strat = new StrategyState(cfg);

  while (true) {
    // update anchor (read price from pool via PoolManager.getPrice)
    const erc20EthPrice = await poolManager.getPrice(0);
    const currentTime = nowSec();
    const price = await anchor.twap(currentTime);

    const decision = strat.decide(
      { nowSec: currentTime, spotTokenPerEth: price, anchorTokenPerEth: price }
    );

    const walletRotator = new WalletRotator(provider, cfg.maxConsecutivePerWallet);
    const w = walletRotator.pickRandom();
    walletRotator.markUsed(w);
    const chosenWallet = w.wallet;

    const amountInERC20 = decision.amountERC20;
    const amountInEth = amountInERC20 / price;

    // const deadline = nowSec() + 120;
    const isBuy = decision.side === "BUY";
    if (isBuy) {
      const amountIn = parseEther(amountInEth.toFixed(18));
      // BUY: ETH -> TOKEN.
      const outTokenFloat = amountInEth * price * (1 - decision.slippage);
      // const tokenOut = isEthToken(erc20EthPrice.token0) ? erc20EthPrice.token1 : erc20EthPrice.token0;
      const outMin = toUnitsFloat(outTokenFloat, 18);

      log.log(
        `[BUY] price=${price?.toFixed(6)} WETH amount=${amountInEth.toFixed(6)} slip=${(decision.slippage * 100).toFixed(
          2
        )}% min GMB=${outTokenFloat} delay=${decision.nextDelaySec}s wallet=${chosenWallet.address} `
      );

        await poolManager.swap({
          poolIndex: 0,
          isBuy,
          amountIn,
          amountOutMinimum: outMin
        }, chosenWallet);

    } else {
      // SELL: TOKEN -> ETH.
      const tokenInFloat = amountInEth * price;
      // const tokenInInfo = isEthToken(erc20EthPrice.token0) ? erc20EthPrice.token1 : erc20EthPrice.token0;
      const tokenIn = toUnitsFloat(tokenInFloat, 18);
      const outEthMinFloat = amountInEth * (1 - decision.slippage);
      const outMin = parseEther(outEthMinFloat.toFixed(18));

      log.log(
        `[SELL] price=${price.toFixed(6)} GMB Amount≈${tokenInFloat.toFixed(2)} min ETH=${outEthMinFloat.toFixed(
          4
        )} slip=${(decision.slippage * 100).toFixed(2)}% delay=${decision.nextDelaySec}s wallet=${chosenWallet.address} `
      );

      await poolManager.swap({
        poolIndex: 0,
        isBuy,
        amountIn: tokenIn,
          amountOutMinimum: outMin,
        }, chosenWallet);

    }

    if (DRY_RUN) {
      await sleep(1000);
    } else {
      await sleep(decision.nextDelaySec * 1000);
    }
  }
}


