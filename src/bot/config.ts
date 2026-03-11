import { z } from "zod";

const EnvSchema = z.object({
  RPC_URL: z.string().min(1),
  CHAIN_ID: z.coerce.number().int().positive(),

  UNIVERSAL_ROUTER: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  PERMIT2: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  STATE_VIEW: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  POSITION_MANAGER: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional().default(""),

  // If set, bot will derive PoolKey from on-chain PositionManager.poolKeys(bytes25(poolId))
  POOL_ID: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional().default(""),

  CURRENCY0: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  CURRENCY1: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  FEE: z.coerce.number().int().min(0).max(1_000_000),
  TICK_SPACING: z.coerce.number().int(),
  HOOKS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),

  TOKEN0_DECIMALS: z.coerce.number().int().min(0).max(255),
  TOKEN1_DECIMALS: z.coerce.number().int().min(0).max(255),

  PRIVATE_KEYS: z.string().min(1),

  GAS_LIMIT: z.coerce.number().int().positive().default(300_000),

  BUY_SLIPPAGE_MIN: z.coerce.number().min(0).max(1),
  BUY_SLIPPAGE_MAX: z.coerce.number().min(0).max(1),
  SELL_SLIPPAGE_MIN: z.coerce.number().min(0).max(1),
  SELL_SLIPPAGE_MAX: z.coerce.number().min(0).max(1),

  ETH_USD: z.coerce.number().positive(),
  USD_BUCKET1_MIN: z.coerce.number().positive(),
  USD_BUCKET1_MAX: z.coerce.number().positive(),
  USD_BUCKET1_PCT: z.coerce.number().min(0).max(1),
  USD_BUCKET2_MIN: z.coerce.number().positive(),
  USD_BUCKET2_MAX: z.coerce.number().positive(),
  USD_BUCKET2_PCT: z.coerce.number().min(0).max(1),

  BUY_PCT: z.coerce.number().min(0).max(1),
  SELL_PCT: z.coerce.number().min(0).max(1),
  MAX_CONSECUTIVE: z.coerce.number().int().min(1).default(5),

  INTERVAL1_MIN: z.coerce.number().int().positive(),
  INTERVAL1_MAX: z.coerce.number().int().positive(),
  INTERVAL1_PCT: z.coerce.number().min(0).max(1),
  INTERVAL2_MIN: z.coerce.number().int().positive(),
  INTERVAL2_MAX: z.coerce.number().int().positive(),
  INTERVAL2_PCT: z.coerce.number().min(0).max(1),
  INTERVAL3_MIN: z.coerce.number().int().positive(),
  INTERVAL3_MAX: z.coerce.number().int().positive(),
  INTERVAL3_PCT: z.coerce.number().min(0).max(1),

  ANCHOR_WINDOW_MIN: z.coerce.number().int().positive().default(30),
  ANCHOR_UPDATE_SEC: z.coerce.number().int().positive().default(120),
  UP_ONLY_SELL_PCT: z.coerce.number().min(0).max(1).default(0.05),
  DOWN_ONLY_BUY_PCT: z.coerce.number().min(0).max(1).default(0.05),

  TVL_ETH: z.coerce.number().positive(),
  DAILY_VOL_CAP_PCT: z.coerce.number().min(0).max(1).default(0.8),

  // PoolManager (pool-config.json): which pool index and which side is ETH
  POOL_INDEX: z.coerce.number().int().min(0).default(0),
  ETH_IS_TOKEN0: z
    .string()
    .transform((s) => s === "true" || s === "1")
    .default("true"),
});

export type BotConfig = z.infer<typeof EnvSchema> & {
  privateKeys: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv): BotConfig {
  const parsed = EnvSchema.parse(env);
  const privateKeys = parsed.PRIVATE_KEYS.split(",").map((s) => s.trim()).filter(Boolean);
  if (privateKeys.length < 1) throw new Error("PRIVATE_KEYS is empty");
  return { ...parsed, privateKeys };
}

export type IntervalWeights = Array<{ minSec: number; maxSec: number; weight: number }>;

export type AmountUsdWeights = Array<{ minUsd: number; maxUsd: number; weight: number }>;

export type BotRuntimeConfig = {
    /** rpc url */
    rpcUrl: string;
  /** number of wallets to load from env */
  walletCount: number;
  /** max consecutive trades per wallet before rotating */
  maxConsecutivePerWallet: number;
  /** max consecutive same-side trades before forcing a flip */
  maxConsecutiveSameSide: number;
  /** side weights */
  buyWeight: number;
  sellWeight: number;
  /** interval distribution (seconds) */
  intervals: IntervalWeights;
  /** per-trade notional distribution in USD */
  amountUsd: AmountUsdWeights;
  /** anchor settings */
  anchorWindowSec: number;
  anchorUpdateSec: number;
  /** oscillation band: if price > anchor*(1+band) => only sell; if < anchor*(1-band) => only buy */
  bandBps: number;
  /** daily volume cap fraction of TVL, in basis points (e.g. 8000 = 80%) */
  dailyCapBps: number;
  /** assumed ETH price in USD for converting USD->WETH amount */
  ethUsd: number;
  /** slippage ranges in basis points */
  slippageBuyBpsMin: number;
  slippageBuyBpsMax: number;
  slippageSellBpsMin: number;
  slippageSellBpsMax: number;
  /** tx settings */
  gasLimit: bigint;
  /** if true, do not broadcast txs (still computes and logs) */
  dryRun: boolean;
};

export function defaultConfig(): BotRuntimeConfig {
    return {
      rpcUrl: "https://eth-sepolia.api.onfinality.io/public",
      walletCount: 30,
      maxConsecutivePerWallet: 5,
      maxConsecutiveSameSide: 4,
      buyWeight: 55,
      sellWeight: 45,
      intervals: [
        { minSec: 150, maxSec: 300, weight: 30 },
        { minSec: 300, maxSec: 600, weight: 50 },
        { minSec: 600, maxSec: 1200, weight: 20 },
      ],
      amountUsd: [
        { minUsd: 2, maxUsd: 50, weight: 90 },
        { minUsd: 50, maxUsd: 100, weight: 10 },
      ],
      anchorWindowSec: 30 * 60,
      anchorUpdateSec: 2 * 60,
      bandBps: 500,
      dailyCapBps: 8000,
      ethUsd: 3000,
      slippageBuyBpsMin: 80,
      slippageBuyBpsMax: 150,
      slippageSellBpsMin: 60,
      slippageSellBpsMax: 120,
      gasLimit: 300_000n,
      dryRun: false,
    };
  }