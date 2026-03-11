import { JsonRpcProvider, parseUnits, Wallet } from "ethers";
import "dotenv/config";
import { PoolManager } from "../src/pool-manager.js";

let poolManager: PoolManager | null = null;

function getPoolManager(): PoolManager {
  if (!poolManager) {
    poolManager = PoolManager.load();
  }
  return poolManager;
}

export type SwapV3PoolExactInputSingleArgs = {
  /** Index into the pool list in pool-config.json */
  poolIndex: number;
  /** true = token0 -> token1, false = token1 -> token0 */
  sellToken0: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline?: number | null;
  sqrtPriceLimitX96?: bigint;
};

/**
 * Execute exactInputSingle swap for the pool at the given index.
 * Uses PoolManager.swap() under the hood.
 */
export async function swapV3PoolExactInputSingle(
  args: SwapV3PoolExactInputSingleArgs,
) {
  const pm = getPoolManager();
  const wallet = new Wallet(process.env.PRIVATE_KEY!, new JsonRpcProvider(process.env.RPC_URL!));
  return pm.swap({
    poolIndex: args.poolIndex,
    sellToken0: args.sellToken0,
    amountIn: args.amountIn,
    amountOutMinimum: args.amountOutMinimum,
    deadline: args.deadline ?? null,
    sqrtPriceLimitX96: args.sqrtPriceLimitX96,
  }, wallet);
}

async function main() {
  const pm = getPoolManager();
  const pool = pm.getPool(0);

  const amountInHuman = "0.0000001";
  // isBuy = true => pay token1 (e.g. WETH), receive token0 (e.g. GMB) => sellToken0 = false
  const isBuy = true;
  const sellToken0 = !isBuy;

  const tokenInInfo = sellToken0 ? pool.token0Info : pool.token1Info;
  const decIn = Number(tokenInInfo.decimals);
  const amountIn = parseUnits(amountInHuman, decIn);

  await swapV3PoolExactInputSingle({
    poolIndex: 0,
    sellToken0,
    amountIn,
    amountOutMinimum: 0n,
    deadline: null,
    sqrtPriceLimitX96: 0n,
  });
}

await main();
