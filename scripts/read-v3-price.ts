import "dotenv/config";
import { PoolManager, formatRational } from "../src/bot/pool-manager.js";
import { calculatePrices } from "../src/v3-utils.js";
import { getProvider } from "../src/bot/get-provider.js";
import { defaultConfig } from "../src/bot/config.js";

let poolManager: PoolManager | null = null;

function getPoolManager(): PoolManager {
  if (!poolManager) {
    const cfg = defaultConfig();
    const provider = getProvider(cfg.rpcUrl);
    poolManager = PoolManager.load(console, provider);
  }
  return poolManager;
}

async function main() {
  const pm = getPoolManager();
  const poolIndex = 0;

  const {
    poolAddress,
    rpcUrl,
    fee,
    sqrtPriceX96,
    token0: t0,
    token1: t1,
    num1Per0,
    den1Per0,
    num0Per1,
    den0Per1,
  } = await pm.getPrice(poolIndex);

  console.log("V3 Pool:", poolAddress);
  console.log("RPC:", rpcUrl);
  console.log("Fee:", `${Number(fee) / 10_000}%`);
  console.log(
    "token0:",
    t0.symbol || t0.name || "",
    t0.address,
    `(decimals=${t0.decimals})`,
  );
  console.log(
    "token1:",
    t1.symbol || t1.name || "",
    t1.address,
    `(decimals=${t1.decimals})`,
  );
  console.log("sqrtPriceX96:", sqrtPriceX96.toString());
  console.log();
  // // Token1 相对 Token0 的价格
  const calculatedPrice = calculatePrices(sqrtPriceX96.toString(), Number(t0.decimals), Number(t1.decimals));
  console.log(
    `Price (token1 per token0): 1 ${t0.symbol || "token0"} = ${calculatedPrice.token1PerToken0} ${t1.symbol || "token1"}`,
  );
  console.log(
    `Price (token0 per token1): 1 ${t1.symbol || "token1"} = ${calculatedPrice.token0PerToken1} ${t0.symbol || "token0"}`,
  );

  const twap = await pm.getTwap24h(poolIndex);
  console.log();
  console.log(`TWAP window: ${twap.windowSeconds}s (${twap.windowSeconds / 3600}h)`);
  console.log("TWAP averageTick:", twap.averageTick);
  console.log(
    `TWAP (token1 per token0): 1 ${t0.symbol || "token0"} = ${formatRational(twap.num1Per0, twap.den1Per0, 12)} ${t1.symbol || "token1"}`,
  );
  console.log(
    `TWAP (token0 per token1): 1 ${t1.symbol || "token1"} = ${formatRational(twap.num0Per1, twap.den0Per1, 12)} ${t0.symbol || "token0"}`,
  );
}


await main();
