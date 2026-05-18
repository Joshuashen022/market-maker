import { PoolManager, PoolPriceResult } from "./pool-manager.js";
import { calculatePrices } from "../v3-utils.js";
import { BotRuntimeConfig } from "./config.js";
import { Log } from "../logger.js";
const DRY_RUN = process.env.DRY_RUN || false;

export type PriceSample = {
    t: number; // unix seconds
    priceTokenPerEth: number; // TOKEN per 1 ETH (spot)
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build PriceSample from pool prices. priceTokenPerEth = TOKEN per 1 ETH. */
function priceResultToSample(erc20EthPrice: PoolPriceResult): PriceSample {
  const priceTokenPerEth = calculatePrices(erc20EthPrice.sqrtPriceX96.toString(), Number(erc20EthPrice.token0.decimals), Number(erc20EthPrice.token1.decimals)).token0PerToken1;
  return { t: nowSec(), priceTokenPerEth: Number(priceTokenPerEth)};
}


export class AnchorPrice {
    private samples: PriceSample[] = [];
    private readonly windowSec: number;
    private readonly poolManager: PoolManager;
    private readonly trackPriceIntervalSec: number;
    private readonly log: Log;
    constructor(cfg: BotRuntimeConfig, poolManager: PoolManager, log: Log) {
      this.windowSec = cfg.anchorWindowSec;
      this.poolManager = poolManager;
      this.trackPriceIntervalSec = cfg.anchorUpdateSec;
      this.log = log;
      console.log("Tracking price every", this.trackPriceIntervalSec, "seconds");
    }

    add(sample: PriceSample) {
      this.samples.push(sample);
      this.prune(sample.t);
    }
    async trackPrice() {
     
      while (true) {        
        const sample = await this.getSample();
        this.add(sample);
        if (DRY_RUN) {
          await sleep(1000);
          console.log("Dry run: tracked price", sample.priceTokenPerEth);
        }
        else {
          await sleep(this.trackPriceIntervalSec * 1000);
        }
        
      }
    }

    private async getSample(): Promise<PriceSample> {
      const erc20EthPrice = await this.poolManager.getPrice(0);
      return priceResultToSample(erc20EthPrice);
    }

    private prune(nowSec: number) {
      const cutoff = nowSec - this.windowSec;
      while (this.samples.length > 0 && this.samples[0]!.t < cutoff) this.samples.shift();
    }
  
    // Time-weighted average price across samples (piecewise-constant).
    async twap(nowSec: number): Promise<number> {
      this.prune(nowSec);
      const defaultSample = await this.getSample();
      if (DRY_RUN) {
        console.log("Dry run: sample", this.samples.length);
      }
      if (this.samples.length < 2) return defaultSample.priceTokenPerEth;
      let weighted = 0;
      let total = 0;
      for (let i = 0; i < this.samples.length - 1; i++) {
        const a = this.samples[i]!;
        const b = this.samples[i + 1]!;
        const dt = Math.max(0, b.t - a.t);
        weighted += a.priceTokenPerEth * dt;
        total += dt;
      }
      const last = this.samples[this.samples.length - 1]!;
      const dtTail = Math.max(0, nowSec - last.t);
      weighted += last.priceTokenPerEth * dtTail;
      total += dtTail;
      if (DRY_RUN) {
        console.log("Dry run: weighted", weighted, "total", total);
      }
      if (total <= 0) return defaultSample.priceTokenPerEth;
      return weighted / total;
    }
  
    latest(): PriceSample | null {
      return this.samples.length ? this.samples[this.samples.length - 1]! : null;
    }
  }
  

  
  