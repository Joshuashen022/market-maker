import "dotenv/config";
import { Decimal } from 'decimal.js';
import { PoolManager, formatRational } from "../src/pool-manager.js";

let poolManager: PoolManager | null = null;

function getPoolManager(): PoolManager {
  if (!poolManager) {
    poolManager = PoolManager.load();
  }
  return poolManager;
}

async function main() {
  const pm = getPoolManager();
  const poolIndex = 1;

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
}

export function calculatePrices(
  sqrtPriceX96: string | bigint,
  decimal0: number,
  decimal1: number
) {
  const q96 = new Decimal(2).pow(96);
  const sqrtPrice = new Decimal(sqrtPriceX96.toString());

  // 1. 计算核心价格 P = (sqrtPrice / 2^96) ^ 2
  // 这代表了 1 份最小单位(wei)的 token0 等于多少份最小单位的 token1
  const priceRaw = sqrtPrice.div(q96).pow(2);

  // 2. 调整精度差异
  // 公式: P_human = P_raw * (10^decimal0 / 10^decimal1)
  const scalar = new Decimal(10).pow(decimal0).div(new Decimal(10).pow(decimal1));
  
  const price0 = priceRaw.mul(scalar); // 1 Token0 = X Token1
  const price1 = new Decimal(1).div(price0); // 1 Token1 = Y Token0

  return {
    token1PerToken0: price0.toString(),
    token0PerToken1: price1.toString(),
    // 转换为更易读的数字格式 (可选)
    token1PerToken0Fixed: price0.toFixed(6),
    token0PerToken1Fixed: price1.toFixed(18),
  };
}

await main();
