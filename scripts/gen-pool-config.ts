import { writeFileSync } from "fs";
import path from "path";
import "dotenv/config";
import { getTokenBasicInfo, getV3PoolBasicInfo } from "../src/v3-utils.js";

const DEFAULT_POOL = "0x614dED58306b844ab755A5A81C3303c07a6D164F";
const DEFAULT_RPC_URL = "https://eth-sepolia.api.onfinality.io/public";

/**
 * Get list of pool addresses from:
 * 1. CLI args: npx tsx gen-pool-config.ts 0xaddr1 0xaddr2 ...
 * 2. Env POOL_LIST: comma-separated addresses
 * 3. Env POOL: single address
 * 4. Default single pool
 */
function getPoolAddressList(): string[] {
  const args = process.argv.slice(2).filter((a) => a.trim().length > 0);
  if (args.length > 0) {
    return args.map((a) => a.trim());
  }
  const listEnv = process.env.POOL_LIST?.trim();
  if (listEnv) {
    return listEnv.split(",").map((a) => a.trim()).filter(Boolean);
  }
  const single = (process.env.POOL ?? DEFAULT_POOL).trim();
  return [single];
}

async function main() {
  const rpcUrl = (
    process.env.SEPOLIA_RPC_URL ?? process.env.RPC_URL ?? DEFAULT_RPC_URL
  ).trim();
  const poolAddresses = getPoolAddressList();

  if (poolAddresses.length === 0) {
    throw new Error("No pool addresses provided (use CLI args or POOL_LIST / POOL env)");
  }

  const list: Array<{
    rpcUrl: string;
    poolAddress: string;
    poolFee: string;
    token0Info: { address: string; symbol: string; name: string; decimals: string };
    token1Info: { address: string; symbol: string; name: string; decimals: string };
  }> = [];

  for (const poolAddress of poolAddresses) {
    const poolInfo = await getV3PoolBasicInfo(rpcUrl, poolAddress);

    const [token0Info, token1Info] = await Promise.all([
      getTokenBasicInfo(rpcUrl, poolInfo.token0),
      getTokenBasicInfo(rpcUrl, poolInfo.token1),
    ]);

    list.push({
      rpcUrl,
      poolAddress: poolInfo.poolAddress,
      poolFee: String(poolInfo.fee),
      token0Info: {
        address: token0Info.address,
        symbol: token0Info.symbol,
        name: token0Info.name,
        decimals: String(token0Info.decimals),
      },
      token1Info: {
        address: token1Info.address,
        symbol: token1Info.symbol,
        name: token1Info.name,
        decimals: String(token1Info.decimals),
      },
    });
  }

  const outPath = path.join(process.cwd(), "scripts", "pool-config.json");
  const serialized = JSON.stringify(list, null, 2);
  writeFileSync(outPath, serialized, "utf8");
  console.log(`Wrote ${list.length} pool(s) to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
