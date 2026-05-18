import {
  Contract,
  ethers,
  JsonRpcProvider,
  MaxUint256,
  Transaction,
  Wallet,
  type TransactionReceipt,
  type TransactionResponse,
} from "ethers";
import { readFileSync } from "fs";
import path from "path";
import "dotenv/config";
import { Decimal } from "decimal.js";
import type { Log } from "../logger.js";
import { parseEther, parseUnits } from "ethers/utils";
import { WalletRotator } from "./wallet-rotator.js";
const DRY_RUN = process.env.DRY_RUN || false;

// --- Types (match pool-config.json) ---

export type TokenInfoFromConfig = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
};

export type PoolConfigItem = {
  rpcUrl: string;
  poolAddress: string;
  poolFee: number;
  token0Info: TokenInfoFromConfig;
  token1Info: TokenInfoFromConfig;
};

export type PoolConfigList = PoolConfigItem[];

// --- Price result from getPrice() ---

export type PoolPriceResult = {
  poolAddress: string;
  rpcUrl: string;
  fee: number;
  sqrtPriceX96: bigint;
  token0: TokenInfoFromConfig;
  token1: TokenInfoFromConfig;
  num1Per0: bigint;
  den1Per0: bigint;
  num0Per1: bigint;
  den0Per1: bigint;
};

// --- TWAP result from getTwap24h() ---

export type PoolTwapResult = {
  poolAddress: string;
  rpcUrl: string;
  fee: number;
  /** Arithmetic mean tick over the window. */
  averageTick: number;
  /** token1 per token0 TWAP, as a rational number */
  num1Per0: bigint;
  den1Per0: bigint;
  /** token0 per token1 TWAP, as a rational number */
  num0Per1: bigint;
  den0Per1: bigint;
  /** Window size in seconds (24h). */
  windowSeconds: number;
};

// --- Swap args and result ---
const V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const WETH_ABI = [
  "function deposit() payable",
  "function withdraw(uint256 amount) payable",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const SWAP_ROUTER_ABI_WITH_DEADLINE = [
  "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
];
const SWAP_ROUTER_ABI_NO_DEADLINE = [
  "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
];

function pow10(n: number): bigint {
  if (n < 0) throw new Error("pow10 expects n >= 0");
  return 10n ** BigInt(n);
}

async function retryUntilSuccess<T>(
  operationName: string,
  operation: () => Promise<T>,
  retryDelayMs = 1_000,
): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[PoolManager] ${operationName} failed on attempt ${attempt}, retrying in ${retryDelayMs}ms: ${message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

export function formatRational(
  numerator: bigint,
  denominator: bigint,
  fractionalDigits = 18,
): string {
  if (denominator === 0n) return "NaN";
  const sign = numerator < 0n ? "-" : "";
  const n = numerator < 0n ? -numerator : numerator;
  const intPart = n / denominator;
  const fracScale = 10n ** BigInt(fractionalDigits);
  const fracPart = (n % denominator) * fracScale / denominator;
  const fracStr = fracPart.toString().padStart(fractionalDigits, "0").replace(/0+$/, "");
  return fracStr.length ? `${sign}${intPart.toString()}.${fracStr}` : `${sign}${intPart.toString()}`;
}

function divTowardNegativeInfinity(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("division by zero");
  const q = a / b;
  const r = a % b;
  if (r === 0n) return q;
  // JS bigint division truncates toward 0; adjust so it floors for negatives.
  return (a < 0n) !== (b < 0n) ? q - 1n : q;
}

function decimalToScaledRational(
  value: Decimal,
  scaleDigits = 18,
): { numerator: bigint; denominator: bigint } {
  if (!value.isFinite()) throw new Error("TWAP price is not finite");
  if (value.isNeg()) throw new Error("TWAP price is negative");
  const scale = new Decimal(10).pow(scaleDigits);
  // Round down to stay conservative (no overestimation).
  const scaled = value.mul(scale).floor();
  const asString = scaled.toFixed(0);
  return {
    numerator: BigInt(asString),
    denominator: 10n ** BigInt(scaleDigits),
  };
}

// --- PoolManager ---

export type SwapArgs = {
  poolIndex: number;
  /** true = token1 -> token0  false = token0 -> token1, */
  isBuy: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline?: number | null;
  sqrtPriceLimitX96?: bigint;
  gasLimit?: number;
  gasPrice?: number;
};

export type SwapResult = {
  txHash: string;
};

export class PoolManager {
  readonly pools: PoolConfigItem[];
  readonly log: Log;
  provider: JsonRpcProvider;
  walletRotator: WalletRotator;
  constructor(pools: PoolConfigItem[], log: Log, provider: JsonRpcProvider) {
    this.pools = pools;
    this.log = log;
    this.provider = provider;
    this.walletRotator = new WalletRotator(provider, 5);
  }

  // we trust the config file, so we don't need to check the pool address
  static load(log: Log, provider: JsonRpcProvider, configPath?: string): PoolManager {
    const cfgPath =
      configPath ?? path.join(process.cwd(), "config", "pool-config.json");
    const raw = readFileSync(cfgPath, "utf8");
    const list = JSON.parse(raw) as PoolConfigList;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("pool-config.json must be a non-empty array of pool configs");
    }
    return new PoolManager(list, log, provider);
  }

  getPool(index: number): PoolConfigItem {
    const p = this.pools[index];
    if (!p) throw new Error(`Pool index ${index} out of range (have ${this.pools.length} pools)`);
    return p;
  }

  /** Get current price for a pool (logic from read-v3-price). */
  async getPrice(poolIndex: number): Promise<PoolPriceResult> {
    const cfg = this.getPool(poolIndex);
    const pool = new Contract(cfg.poolAddress, V3_POOL_ABI, this.provider);

    const [fee, slot0] = await Promise.all([
      retryUntilSuccess("pool.fee()", () => pool.fee() as Promise<number>),
      retryUntilSuccess(
        "pool.slot0()",
        () =>
          pool.slot0() as Promise<
            readonly [bigint, number, number, number, number, number, boolean]
          >,
      ),
    ]);

    const sqrtPriceX96 = slot0[0];
    const dec0 = Number(cfg.token0Info.decimals);
    const dec1 = Number(cfg.token1Info.decimals);

    const q192 = 2n ** 192n;
    const sqrt2 = sqrtPriceX96 * sqrtPriceX96;
    const num1Per0 = sqrt2 * pow10(dec0);
    const den1Per0 = q192 * pow10(dec1);
    const num0Per1 = den1Per0;
    const den0Per1 = num1Per0;
    // // Token1 相对 Token0 的价格
    // const price1Per0 = (num1Per0 / den1Per0)/ BigInt(10 ** (dec0 - dec1));
    // // Token0 相对 Token1 的价格
    // const price0Per1 = (num0Per1 / den0Per1)/ BigInt(10 ** (dec1 - dec0));

    return {
      poolAddress: cfg.poolAddress,
      rpcUrl: cfg.rpcUrl,
      fee,
      sqrtPriceX96,
      token0: cfg.token0Info,
      token1: cfg.token1Info,
      num1Per0,
      den1Per0,
      num0Per1,
      den0Per1,
    };
  }
 
  /**
   * Calculate 24h TWAP using Uniswap V3 observations.
   * Returns token1/token0 and token0/token1 TWAP as rationals.
   */
  async getTwap24h(poolIndex: number): Promise<PoolTwapResult> {
    const windowSeconds = 24 * 60 * 60;
    const cfg = this.getPool(poolIndex);
    const pool = new Contract(cfg.poolAddress, V3_POOL_ABI, this.provider);

    const [fee, observed] = await Promise.all([
      retryUntilSuccess("pool.fee()", () => pool.fee() as Promise<number>),
      retryUntilSuccess("pool.observe([24h,0])", () =>
        pool.observe([windowSeconds, 0]) as Promise<
          readonly [readonly bigint[], readonly bigint[]]
        >,
      ),
    ]);

    const tickCumulatives = observed[0];
    if (!Array.isArray(tickCumulatives) || tickCumulatives.length < 2) {
      throw new Error("pool.observe returned unexpected tickCumulatives");
    }

    const tickCumPast = BigInt(tickCumulatives[0] as unknown as bigint);
    const tickCumNow = BigInt(tickCumulatives[1] as unknown as bigint);
    const tickCumulativeDelta = tickCumNow - tickCumPast;

    // Uniswap uses floor division for negative values to get a consistent mean tick.
    const meanTickBig = divTowardNegativeInfinity(
      tickCumulativeDelta,
      BigInt(windowSeconds),
    );
    const averageTick = Number(meanTickBig);
    if (!Number.isFinite(averageTick)) {
      throw new Error("averageTick is not a finite number");
    }
    // Uniswap v3 tick bounds.
    if (averageTick < -887272 || averageTick > 887272) {
      throw new Error(`averageTick out of bounds: ${averageTick}`);
    }

    const dec0 = Number(cfg.token0Info.decimals);
    const dec1 = Number(cfg.token1Info.decimals);

    // price(token1/token0) in raw units is 1.0001^tick.
    // Convert to human units by multiplying by 10^(dec0 - dec1).
    const base = new Decimal("1.0001");
    const price1Per0 = base.pow(averageTick).mul(
      new Decimal(10).pow(dec0 - dec1),
    );

    const { numerator: num1Per0, denominator: den1Per0 } = decimalToScaledRational(
      price1Per0,
      18,
    );
    const num0Per1 = den1Per0;
    const den0Per1 = num1Per0 === 0n ? 1n : num1Per0; // avoid 0 denom in formatting paths

    return {
      poolAddress: cfg.poolAddress,
      rpcUrl: cfg.rpcUrl,
      fee,
      averageTick,
      num1Per0,
      den1Per0,
      num0Per1,
      den0Per1,
      windowSeconds,
    };
  }

  /** Execute exactInputSingle swap (logic from swap-v3-pool). */
  async swap(args: SwapArgs, wallet: Wallet): Promise<SwapResult> {
    const {
      poolIndex,
      isBuy,
      amountIn,
      amountOutMinimum,
      deadline = null,
      sqrtPriceLimitX96 = 0n,
      gasLimit = 300_000,
      gasPrice = undefined,
    } = args;

    const cfg = this.getPool(poolIndex);
    const rpcUrl = cfg.rpcUrl;
    const poolAddress = cfg.poolAddress;
    const fee = Number(cfg.poolFee);
    const swapRouterAddress = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E";
    const routerHasDeadlineFinal = deadline !== null;

    const tokenInAddr = isBuy ? cfg.token1Info.address : cfg.token0Info.address;
    const tokenOutAddr = isBuy ? cfg.token0Info.address : cfg.token1Info.address;
    const symbolIn = isBuy ? cfg.token1Info.symbol : cfg.token0Info.symbol;
    const symbolOut = isBuy ? cfg.token0Info.symbol : cfg.token1Info.symbol;

    const tokenIn = new Contract(tokenInAddr, ERC20_ABI, wallet);
    const router = new Contract(
      swapRouterAddress,
      routerHasDeadlineFinal ? SWAP_ROUTER_ABI_WITH_DEADLINE : SWAP_ROUTER_ABI_NO_DEADLINE,
      wallet,
    );

    const [bal, allowance] = await Promise.all([
      tokenIn.balanceOf(wallet.address) as Promise<bigint>,
      tokenIn.allowance(wallet.address, swapRouterAddress) as Promise<bigint>,
    ]);
    if (DRY_RUN) {
      console.log("Dry run: RPC:", rpcUrl);
      console.log("Dry run: Pool:", poolAddress);
      console.log("Dry run: SwapRouter:", swapRouterAddress);
      console.log("Trader:", wallet.address);
      console.log("Dry run: Direction:", `${symbolIn} -> ${symbolOut}`, `(fee=${fee / 10_000}%)`);
      console.log("Dry run: AmountIn (raw):", amountIn.toString());
      console.log("Dry run: AmountOutMinimum (raw):", amountOutMinimum.toString());
      console.log();
    }

    if (bal < amountIn) {
      if (isBuy){
        const weth = new Contract(tokenInAddr, WETH_ABI, wallet);
        const depositAmount = amountIn + ethers.parseEther("0.0001");
        const txDeposit = await weth.deposit({ value: depositAmount });
        console.log("deposit tx:", txDeposit.hash);
        await txDeposit.wait();
        const newBal = await weth.balanceOf(wallet.address);
        console.log("new weth balance:", newBal.toString());
      } else {
        throw new Error(
          `Insufficient ${symbolIn} balance. Have=${Number(bal)/ 10 ** 18}, need=${Number(amountIn)/ 10 ** 18}.`,
        );
      }
    }

    if (allowance < amountIn) {
      console.log("Approving tokenIn to router...");
      const txApprove = await tokenIn.approve(swapRouterAddress, MaxUint256);
      console.log("approve tx:", txApprove.hash);
      await txApprove.wait();
    }

    const deadlineFinal = deadline ?? Math.floor(Date.now() / 1000) + 20 * 60;

    const params = routerHasDeadlineFinal
      ? {
          tokenIn: tokenInAddr,
          tokenOut: tokenOutAddr,
          fee,
          recipient: wallet.address,
          deadline: deadlineFinal,
          amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96,
        }
      : {
          tokenIn: tokenInAddr,
          tokenOut: tokenOutAddr,
          fee,
          recipient: wallet.address,
          amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96,
        };
    
    const provider = wallet.provider;
    if (!provider) {
      throw new Error("Wallet has no provider; cannot broadcast swap");
    }

    const txData = await router.exactInputSingle.populateTransaction(params, {
      gasLimit,
      gasPrice,
    });
    
    // Ensure chainId/nonce/fee fields are filled from the connected provider
    const txToSign = await wallet.populateTransaction(txData);
    const signedTx = await wallet.signTransaction(txToSign);
    const parsed = Transaction.from(signedTx);
    this.log.log("Swapping...", params, "swap tx:", parsed.hash);
    if (!DRY_RUN) {
      try {
        provider.broadcastTransaction(signedTx);
        console.log("sending tx to blockchain:", parsed.hash);
      } catch (error) {
        console.error("swap failed:", error);
        throw error;
      }
    }
    return {
      txHash: parsed.hash as string,
    } as SwapResult;
  } 

  async swapWithWallet(args: SwapArgs, walletIndex: number): Promise<SwapResult> {
    const wallet = this.walletRotator.pickWallet(walletIndex);
    return this.swap(args, wallet);
  }

  async swap2(
    isBuy: boolean, 
    amountInERC20: number, 
    price: number, 
    walletIndex: number,
    slippage: number,
    poolIndex: number
  ): Promise<SwapResult> {
    const wallet = this.walletRotator.pickWallet(walletIndex);
    const amountInEth = amountInERC20 / price;
    const cfg = this.getPool(poolIndex);
    const token0decimals = Number(cfg.token0Info.decimals);
    const token1decimals = Number(cfg.token1Info.decimals);
    if (isBuy) {
      const amountIn = parseUnits(amountInEth.toFixed(token1decimals), token1decimals); // token 1
      const outTokenFloat = amountInERC20 * (1 - slippage);
      const outMin = parseUnits(outTokenFloat.toFixed(token0decimals), token0decimals); // token 0
      return this.swap({
        poolIndex,
        isBuy,
        amountIn,
        amountOutMinimum: outMin
      }, wallet);
    } else {
      const tokenInFloat = amountInERC20;
      const tokenIn = parseUnits(tokenInFloat.toFixed(token0decimals), token0decimals); // token 0
      const outEthMinFloat = amountInEth * (1 - slippage);
      const outMin = parseUnits(outEthMinFloat.toFixed(token1decimals), token1decimals); // token 1

      return this.swap({
        poolIndex,
        isBuy,
        amountIn: tokenIn,
        amountOutMinimum: outMin
      }, wallet);
    }
    
  }
  
}
