import { Wallet, JsonRpcProvider } from "ethers";
import { readFileSync } from "fs";
import path from "path";

export type WalletSlot = {
  wallet: Wallet;
  consecutiveTrades: number;
};

type GeneratedKeyEntry = {
  privateKey: string;
  address?: string;
};

function loadPrivateKeysFromGeneratedFile(): string[] {
  const filePath = path.join(process.cwd(), "config", "generated-keys.json");
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error(`generated-keys.json must be a JSON array: ${filePath}`);
  }

  const privateKeys = parsed
    .map((v) => v as GeneratedKeyEntry)
    .map((v) => (typeof v?.privateKey === "string" ? v.privateKey.trim() : ""))
    .filter(Boolean);

  if (privateKeys.length === 0) {
    throw new Error(`No privateKey entries found in ${filePath}`);
  }

  return privateKeys;
}

export class WalletRotator {
  private readonly slots: WalletSlot[];
  private readonly maxConsecutive: number;

  constructor(rpcUrl: string, maxConsecutive: number) {
    const privateKeys = loadPrivateKeysFromGeneratedFile();
    
    if (privateKeys.length === 0) throw new Error("WalletRotator: need at least 1 private key");
    if (maxConsecutive <= 0) throw new Error("WalletRotator: maxConsecutive must be > 0");
    this.maxConsecutive = maxConsecutive;
    const provider = new JsonRpcProvider(rpcUrl);
    this.slots = privateKeys.map((pk) => ({
      wallet: new Wallet(pk, provider),
      consecutiveTrades: 0,
    }));
  }

  /** Picks a random wallet with remaining consecutive capacity, otherwise resets all counters and picks again. */
  pickRandom(): WalletSlot {
    const candidates = this.slots.filter((s) => s.consecutiveTrades < this.maxConsecutive);
    if (candidates.length === 0) {
      for (const s of this.slots) s.consecutiveTrades = 0;
      return this.pickRandom();
    }
    const idx = Math.floor(Math.random() * candidates.length);
    return candidates[idx]!;
  }

  markUsed(slot: WalletSlot) {
    slot.consecutiveTrades += 1;
  }

  resetSlot(slot: WalletSlot) {
    slot.consecutiveTrades = 0;
  }

  getAll() {
    return [...this.slots];
  }
}

