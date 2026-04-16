import "dotenv/config";
import { Contract, Wallet } from "ethers";
import { PoolManager } from "../src/bot/pool-manager.js";
import { defaultConfig } from "../src/bot/config.js";
import { getProvider } from "../src/bot/get-provider.js";

const V3_POOL_OBSERVATION_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function increaseObservationCardinalityNext(uint16 observationCardinalityNext)",
  "function observations(uint256 index) view returns (uint32 blockTimestamp,int56 tickCumulative,uint160 secondsPerLiquidityCumulativeX128,bool initialized)",
] as const;

export type IncreaseObservationCardinalityArgs = {
  poolIndex: number;
  targetObservationCardinalityNext: number;
  privateKey: string;
};

export type ReadObservationArgs = {
  poolIndex: number;
  privateKey: string;
  observationIndex?: number;
};

function parseUint16(value: string, fallback: number): number {
  const n = Number(value || fallback);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid uint16 value: ${value}`);
  }
  return n;
}

function getPoolAndWallet(poolIndex: number, privateKey: string) {
  const bootstrapProvider = getProvider(defaultConfig().rpcUrl);
  const pm = PoolManager.load(console, bootstrapProvider);
  const poolCfg = pm.getPool(poolIndex);
  const provider = getProvider(poolCfg.rpcUrl);
  const wallet = new Wallet(privateKey, provider);
  const pool = new Contract(poolCfg.poolAddress, V3_POOL_OBSERVATION_ABI, wallet);
  return { poolCfg, wallet, pool };
}

/**
 * Calls increaseObservationCardinalityNext on a configured V3 pool.
 */
export async function increaseObservationCardinalityNextForPool(
  args: IncreaseObservationCardinalityArgs,
) {
  const { poolCfg, wallet, pool } = getPoolAndWallet(args.poolIndex, args.privateKey);

  const slot0Before = await pool.slot0() as readonly [bigint, number, number, number, number, number, boolean];
  const cardinalityBefore = Number(slot0Before[3]);
  const cardinalityNextBefore = Number(slot0Before[4]);

  console.log("Pool:", poolCfg.poolAddress);
  console.log("Wallet:", wallet.address);
  console.log("Current observationCardinality:", cardinalityBefore);
  console.log("Current observationCardinalityNext:", cardinalityNextBefore);
  console.log("Target observationCardinalityNext:", args.targetObservationCardinalityNext);

  if (args.targetObservationCardinalityNext <= cardinalityNextBefore) {
    console.log("No tx sent: target is not greater than current observationCardinalityNext.");
    return;
  }

  const tx = await pool.increaseObservationCardinalityNext(
    args.targetObservationCardinalityNext,
  );
  console.log("increaseObservationCardinalityNext tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("tx status:", receipt?.status ?? "unknown");

  const slot0After = await pool.slot0() as readonly [bigint, number, number, number, number, number, boolean];
  const cardinalityAfter = Number(slot0After[3]);
  const cardinalityNextAfter = Number(slot0After[4]);
  console.log("After observationCardinality:", cardinalityAfter);
  console.log("After observationCardinalityNext:", cardinalityNextAfter);
}

/**
 * Read one observation entry from pool.observations(index).
 * If observationIndex is omitted, reads the current slot0.observationIndex.
 */
export async function readObservation(args: ReadObservationArgs) {
  const { poolCfg, wallet, pool } = getPoolAndWallet(args.poolIndex, args.privateKey);
  const slot0 = await pool.slot0() as readonly [bigint, number, number, number, number, number, boolean];
  const currentObservationIndex = Number(slot0[2]);
  console.log("currentObservationIndex:", currentObservationIndex);
  const indexToRead = args.observationIndex ?? currentObservationIndex;

  if (!Number.isInteger(indexToRead) || indexToRead < 0 || indexToRead > 65534) {
    throw new Error(`Invalid observation index: ${indexToRead}`);
  }

  const obs = await pool.observations(indexToRead) as readonly [number, bigint, bigint, boolean];
  const blockTimestamp = Number(obs[0]);
  const tickCumulative = BigInt(obs[1] as unknown as bigint);
  const secondsPerLiquidityCumulativeX128 = BigInt(obs[2] as unknown as bigint);
  const initialized = Boolean(obs[3]);

  console.log("Pool:", poolCfg.poolAddress);
  console.log("Wallet:", wallet.address);
  console.log("slot0.observationIndex:", currentObservationIndex);
  console.log("Read observation index:", indexToRead);
  console.log("Observation.initialized:", initialized);
  console.log("Observation.blockTimestamp:", blockTimestamp);
  console.log("Observation.tickCumulative:", tickCumulative.toString());
  console.log(
    "Observation.secondsPerLiquidityCumulativeX128:",
    secondsPerLiquidityCumulativeX128.toString(),
  );

  return {
    index: indexToRead,
    initialized,
    blockTimestamp,
    tickCumulative,
    secondsPerLiquidityCumulativeX128,
  };
}

async function main() {
  const poolIndex = Number(process.env.POOL_INDEX ?? "0");
  if (!Number.isInteger(poolIndex) || poolIndex < 0) {
    throw new Error(`Invalid POOL_INDEX: ${process.env.POOL_INDEX}`);
  }

  const duration = 24 * 60 * 60; // 24 hours
  const targetObservationCardinalityNext = Math.floor(duration / 12);
  console.log("targetObservationCardinalityNext:", targetObservationCardinalityNext);

  const privateKey = process.env.PRIVATE_KEY ?? "";
  if (!privateKey) {
    throw new Error("PRIVATE_KEY is required");
  }

  const mode = (process.env.OBS_MODE ?? "read").toLowerCase();
  if (mode === "increase") {
    await increaseObservationCardinalityNextForPool({
      poolIndex,
      targetObservationCardinalityNext,
      privateKey,
    });
    return;
  }

  const observationIndexRaw = process.env.OBS_INDEX;
  const observationIndex = observationIndexRaw == null
    ? undefined
    : Number(observationIndexRaw);
  if (
    observationIndexRaw != null &&
    (observationIndex == null || !Number.isInteger(observationIndex) || observationIndex < 0)
  ) {
    throw new Error(`Invalid OBS_INDEX: ${observationIndexRaw}`);
  }

  await readObservation({
    poolIndex,
    privateKey,
    observationIndex,
  });

  await readObservation({
    poolIndex,
    privateKey,
    observationIndex: 0,
  });
}

await main();
