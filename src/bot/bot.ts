import "dotenv/config";
import { JsonRpcProvider, Wallet, parseEther, parseUnits } from "ethers";
import { PoolManager, PoolPriceResult, formatRational } from "../pool-manager.js";
import { defaultConfig, loadConfig } from "./config.js";
import { AnchorPrice, type PriceSample } from "./anchor.js";
import { StrategyState } from "./strategy.js";
import { WalletRotator } from "./wallet-rotator.js";
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
function priceResultToSample(
  erc20EthPrice: PoolPriceResult,
  ethUsdtPrice: PoolPriceResult
): PriceSample {
  // Pool 0: ERC20 <-> ETH. We want "non-ETH token per 1 ETH".
  const erc20EthEthIsToken0 = isEthToken(erc20EthPrice.token0);
  const priceTokenPerEth = erc20EthEthIsToken0
    ? parseFloat(formatRational(erc20EthPrice.num1Per0, erc20EthPrice.den1Per0, 18))
    : parseFloat(formatRational(erc20EthPrice.num0Per1, erc20EthPrice.den0Per1, 18));

  // Pool 1: ETH <-> USDT (or other USD stable). We want USD per 1 ETH.
  const ethUsdtEthIsToken0 = isEthToken(ethUsdtPrice.token0);
  const ethUsd = ethUsdtEthIsToken0
    ? parseFloat(formatRational(ethUsdtPrice.num1Per0, ethUsdtPrice.den1Per0, 18))
    : parseFloat(formatRational(ethUsdtPrice.num0Per1, ethUsdtPrice.den0Per1, 18));

  return { t: nowSec(), priceTokenPerEth, ethUsd };
}


export async function runBot() {
  const cfg = defaultConfig();
  const poolManager = PoolManager.load();

  const anchor = new AnchorPrice(cfg.anchorWindowSec);
  const strat = new StrategyState(cfg);

  while (true) {
    // update anchor (read price from pool via PoolManager.getPrice)
    const erc20EthPrice = await poolManager.getPrice(0);
    const ethUsdtPrice = await poolManager.getPrice(1);
    const sample = priceResultToSample(erc20EthPrice, ethUsdtPrice);
    console.log("sample", sample);
    anchor.add(sample);
    const twap = anchor.twap(sample.t);

    const decision = strat.decide(
      { nowSec: sample.t, spotTokenPerEth: sample.priceTokenPerEth, anchorTokenPerEth: twap },
      sample.ethUsd
    );
    console.log("decision", decision);
    // const walletRotator = new WalletRotator(cfg.rpcUrl, cfg.maxConsecutivePerWallet);
    // const w = walletRotator.pickRandom();
    // walletRotator.markUsed(w);
    // const chosenWallet = w.wallet;
    const chosenWallet = new Wallet(process.env.PRIVATE_KEY!, new JsonRpcProvider(cfg.rpcUrl));

    const amountInEth = decision.ethAmount;

    // Very rough minOut estimation using spot priceTokenPerEth (ignores pool price impact/fee).
    // BUY: out is TOKEN ~= ethIn * (token/eth) * (1-slippage)
    // SELL: in is TOKEN (needs TOKEN sizing), but our sizing is in ETH; we approximate tokenIn = eth * priceTokenPerEth.
    const spot = sample.priceTokenPerEth;
    if (!Number.isFinite(spot) || spot <= 0) throw new Error("Invalid spot priceTokenPerEth from pool");

    // const deadline = nowSec() + 120;
    const isBuy = decision.side === "BUY";
    if (isBuy) {
      const amountIn = parseEther(amountInEth.toFixed(18));
      // BUY: ETH -> TOKEN.
      const outTokenFloat = amountInEth * spot * (1 - decision.slippage);
      const tokenOut = isEthToken(erc20EthPrice.token0) ? erc20EthPrice.token1 : erc20EthPrice.token0;
      const outMin = toUnitsFloat(outTokenFloat, tokenOut.decimals);

      console.log(
        `[trade][BUY] wallet=${chosenWallet.address} ethIn=${amountInEth.toFixed(6)} slip=${(decision.slippage * 100).toFixed(
          2
        )}% outMin ${outMin} twap=${twap?.toFixed(6) ?? "n/a"} spot=${spot.toFixed(6)} delay=${decision.nextDelaySec}s`
      );

      // await poolManager.swap({
      //   poolIndex: 0,
      //   sellToken0: isBuy,
      //   amountIn,
      //   amountOutMinimum: outMin
      // }, chosenWallet);
      
    } else {
      // SELL: TOKEN -> ETH.
      const tokenInFloat = amountInEth * spot;
      const tokenInInfo = isEthToken(erc20EthPrice.token0) ? erc20EthPrice.token1 : erc20EthPrice.token0;
      const tokenIn = toUnitsFloat(tokenInFloat, tokenInInfo.decimals);
      const outEthMinFloat = amountInEth * (1 - decision.slippage);
      const outMin = parseEther(outEthMinFloat.toFixed(18));

      console.log(
        `[trade][SELL] wallet=${chosenWallet.address} tokenIn≈${tokenInFloat.toFixed(6)} tokenIn=${tokenIn} ethOutMin=${outEthMinFloat.toFixed(
          6
        )} slip=${(decision.slippage * 100).toFixed(2)}% outMin ${outMin} twap=${twap?.toFixed(6) ?? "n/a"} spot=${spot.toFixed(
          6
        )} delay=${decision.nextDelaySec}s`
      );
      // await poolManager.swap({
      //   poolIndex: 0,
      //   sellToken0: isBuy,
      //   amountIn: tokenIn,
      //   amountOutMinimum: outMin,
      // }, chosenWallet);
    }

    await sleep(decision.nextDelaySec * 1000);
  }
}


