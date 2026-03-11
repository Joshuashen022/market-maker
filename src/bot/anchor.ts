export type PriceSample = {
    t: number; // unix seconds
    priceTokenPerEth: number; // TOKEN per 1 ETH (spot)
};

export class AnchorPrice {
    private samples: PriceSample[] = [];
    private readonly windowSec: number;
  
    constructor(windowMin: number) {
      this.windowSec = windowMin;
    }
  
    add(sample: PriceSample) {
      this.samples.push(sample);
      this.prune(sample.t);
    }
  
    private prune(nowSec: number) {
      const cutoff = nowSec - this.windowSec;
      while (this.samples.length > 0 && this.samples[0]!.t < cutoff) this.samples.shift();
    }
  
    // Time-weighted average price across samples (piecewise-constant).
    twap(nowSec: number): number | null {
      this.prune(nowSec);
      if (this.samples.length < 2) return null;
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
      if (total <= 0) return null;
      return weighted / total;
    }
  
    latest(): PriceSample | null {
      return this.samples.length ? this.samples[this.samples.length - 1]! : null;
    }
  }
  

  
  