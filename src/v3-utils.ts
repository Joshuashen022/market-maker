import { Contract, JsonRpcProvider } from "ethers";

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

