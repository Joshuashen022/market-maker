import { Contract, JsonRpcProvider, MaxUint256, Wallet } from "ethers";
import { readFileSync } from "fs";
import path from "path";
import "dotenv/config";

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

// --- Swap args and result ---
const V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
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

// --- PoolManager ---

export type SwapArgs = {
  poolIndex: number;
  /** true = token1 -> token0  false = token0 -> token1, */
  isBuy: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline?: number | null;
  sqrtPriceLimitX96?: bigint;
};

export type SwapResult = {
  txSwap: { hash: string; wait: () => Promise<{ status?: number }> };
  receipt: { status?: number } | undefined;
};

export class PoolManager {
  readonly pools: PoolConfigItem[];

  constructor(pools: PoolConfigItem[]) {
    this.pools = pools;
  }

  static load(configPath?: string): PoolManager {
    const cfgPath =
      configPath ?? path.join(process.cwd(), "config", "pool-config.json");
    const raw = readFileSync(cfgPath, "utf8");
    const list = JSON.parse(raw) as PoolConfigList;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("pool-config.json must be a non-empty array of pool configs");
    }
    return new PoolManager(list);
  }

  getPool(index: number): PoolConfigItem {
    const p = this.pools[index];
    if (!p) throw new Error(`Pool index ${index} out of range (have ${this.pools.length} pools)`);
    return p;
  }

  /** Get current price for a pool (logic from read-v3-price). */
  async getPrice(poolIndex: number): Promise<PoolPriceResult> {
    const cfg = this.getPool(poolIndex);
    const provider = new JsonRpcProvider(cfg.rpcUrl);
    const pool = new Contract(cfg.poolAddress, V3_POOL_ABI, provider);

    const [fee, slot0] = await Promise.all([
      pool.fee() as Promise<number>,
      pool.slot0() as Promise<
        readonly [bigint, number, number, number, number, number, boolean]
      >,
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

  /** Execute exactInputSingle swap (logic from swap-v3-pool). */
  async swap(args: SwapArgs, wallet: Wallet): Promise<SwapResult> {
    const {
      poolIndex,
      isBuy,
      amountIn,
      amountOutMinimum,
      deadline = null,
      sqrtPriceLimitX96 = 0n,
    } = args;

    const cfg = this.getPool(poolIndex);
    const rpcUrl = cfg.rpcUrl;
    const poolAddress = cfg.poolAddress;
    const fee = Number(cfg.poolFee);
    const swapRouterAddress = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E";
    const routerHasDeadlineFinal = deadline !== null;

    const tokenInAddr = isBuy ? cfg.token1Info.address : cfg.token0Info.address;
    const tokenOutAddr = isBuy ? cfg.token0Info.address : cfg.token1Info.address;
    const symIn = isBuy ? cfg.token1Info.symbol : cfg.token0Info.symbol;
    const symOut = isBuy ? cfg.token0Info.symbol : cfg.token1Info.symbol;

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

    console.log("RPC:", rpcUrl);
    console.log("Pool:", poolAddress);
    console.log("SwapRouter:", swapRouterAddress);
    console.log("Trader:", wallet.address);
    console.log("Direction:", `${symIn} -> ${symOut}`, `(fee=${fee / 10_000}%)`);
    console.log("AmountIn (raw):", amountIn.toString());
    console.log("AmountOutMinimum (raw):", amountOutMinimum.toString());
    console.log();

    if (bal < amountIn) {
      if (isBuy){
        const weth = new Contract(tokenInAddr, WETH_ABI, wallet);
        const txDeposit = await weth.deposit({ value: amountIn });
        console.log("deposit tx:", txDeposit.hash);
        await txDeposit.wait();
        const newBal = await weth.balanceOf(wallet.address);
        console.log("new weth balance:", newBal.toString());
      } else {
        throw new Error(
          `Insufficient ${symIn} balance. Have=${Number(bal)/ 10 ** 18}, need=${Number(amountIn)/ 10 ** 18}.`,
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

    console.log("Swapping...");
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

    const txSwap = await router.exactInputSingle(params, { gasLimit: 30_0000 });
    console.log("swap tx:", txSwap.hash);
    const receipt = await txSwap.wait();
    console.log("status:", receipt?.status ?? "unknown");

    return { txSwap, receipt };
  }
}
