import { Contract, JsonRpcProvider } from "ethers";
import { Decimal } from "decimal.js";

const V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
];

export type V3PoolBasicInfo = {
  poolAddress: string;
  token0: string;
  token1: string;
  fee: number;
};

export type TokenBasicInfo = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
};

export async function getV3PoolBasicInfo(rpcUrl: string, poolAddress: string): Promise<V3PoolBasicInfo> {
  const provider = new JsonRpcProvider(rpcUrl);
  const pool = new Contract(poolAddress, V3_POOL_ABI, provider);

  const [token0, token1, fee] = await Promise.all([
    pool.token0() as Promise<string>,
    pool.token1() as Promise<string>,
    pool.fee() as Promise<number>,
  ]);

  return {
    poolAddress,
    token0,
    token1,
    fee,
  };
}

export async function getTokenBasicInfo(
  rpcUrl: string,
  tokenAddress: string,
): Promise<TokenBasicInfo> {
  const provider = new JsonRpcProvider(rpcUrl);
  const erc20 = new Contract(tokenAddress, ERC20_ABI, provider);

  const [symbol, name, decimals] = await Promise.all([
    erc20.symbol().catch(() => "UNKNOWN") as Promise<string>,
    erc20.name().catch(() => "Unknown Token") as Promise<string>,
    erc20.decimals() as Promise<number>,
  ]);

  return {
    address: tokenAddress,
    symbol,
    name,
    decimals,
  };
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
