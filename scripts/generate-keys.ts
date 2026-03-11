import { writeFileSync } from "fs";
import path from "path";
import { Wallet } from "ethers";

const COUNT = 30;
const OUT_PATH = path.join(process.cwd(), "scripts", "generated-keys.json");

const keys = Array.from({ length: COUNT }, () => {
  const w = Wallet.createRandom();
  return { privateKey: w.privateKey, address: w.address };
});

writeFileSync(OUT_PATH, JSON.stringify(keys, null, 2) + "\n", "utf8");
console.log(`Wrote ${keys.length} key(s) to ${OUT_PATH}`);

