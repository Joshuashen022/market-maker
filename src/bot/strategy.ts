import { BotRuntimeConfig } from "./config.js";
import { randFloat, randInt, pickWeighted } from "./random.js";

export type Side = "BUY" | "SELL";

export type StrategyParams = {
  /** probability in [0,1] */
  buyPct: number;
  maxConsecutive: number;

  // USD buckets for amount selection
  usdBuckets: { min: number; max: number; weight: number }[];

  // interval buckets (seconds)
  intervalBuckets: { min: number; max: number; weight: number }[];

  // slippage ranges
  buySlip: { min: number; max: number };
  sellSlip: { min: number; max: number };

  // oscillation guardrails
  upOnlySellPct: number;
  downOnlyBuyPct: number;
};

export type MarketContext = {
  nowSec: number;
  // token per ETH
  spotTokenPerEth: number;
  anchorTokenPerEth: number | null;
};

export type TradeDecision = {
  side: Side;
  usdAmount: number;
  ethAmount: number;
  slippage: number;
  nextDelaySec: number;
};

export class StrategyState {
  private lastSide: Side | null = null;
  private runLen = 0;
  private readonly strategyParams: StrategyParams;
  constructor(private readonly cfg: BotRuntimeConfig) {
    const buyWeight = Math.max(0, cfg.buyWeight);
    const sellWeight = Math.max(0, cfg.sellWeight);
    const total = buyWeight + sellWeight;
    const bandPct = Math.max(0, cfg.bandBps) / 10_000;
    this.strategyParams = {
      buyPct: total > 0 ? buyWeight / total : 0.5,
      maxConsecutive: cfg.maxConsecutiveSameSide,
      usdBuckets: [
        { min: cfg.amountUsd[0].minUsd, max: cfg.amountUsd[0].maxUsd, weight: cfg.amountUsd[0].weight },
        { min: cfg.amountUsd[1].minUsd, max: cfg.amountUsd[1].maxUsd, weight: cfg.amountUsd[1].weight }
      ],
      intervalBuckets: [
          { min: cfg.intervals[0].minSec, max: cfg.intervals[0].maxSec, weight: cfg.intervals[0].weight },
          { min: cfg.intervals[1].minSec, max: cfg.intervals[1].maxSec, weight: cfg.intervals[1].weight },
          { min: cfg.intervals[2].minSec, max: cfg.intervals[2].maxSec, weight: cfg.intervals[2].weight }
      ],
      // convert bps -> fraction
      buySlip: { min: cfg.slippageBuyBpsMin / 10_000, max: cfg.slippageBuyBpsMax / 10_000 },
      sellSlip: { min: cfg.slippageSellBpsMin / 10_000, max: cfg.slippageSellBpsMax / 10_000 },
      upOnlySellPct: bandPct,
      downOnlyBuyPct: bandPct
    };
  }

  decide(mkt: MarketContext, ethUsd: number): TradeDecision {
    const forcedSide = this.forcedSide(mkt);
    let side: Side = forcedSide ?? (Math.random() < this.strategyParams.buyPct ? "BUY" : "SELL");

    // consecutive constraint: "< 5 笔" => enforce runLen < maxConsecutive
    if (this.lastSide === side && this.runLen >= this.strategyParams.maxConsecutive - 1) {
      side = side === "BUY" ? "SELL" : "BUY";
    }

    const usdAmount = this.pickUsdAmount();
    const ethAmount = usdAmount / ethUsd;
    const slippage = this.pickSlippage(side);
    const nextDelaySec = this.pickDelay();

    // update state
    if (this.lastSide === side) this.runLen += 1;
    else {
      this.lastSide = side;
      this.runLen = 1;
    }

    return { side, usdAmount, ethAmount, slippage, nextDelaySec };
  }

  private forcedSide(mkt: MarketContext): Side | null {
    if (!mkt.anchorTokenPerEth || mkt.anchorTokenPerEth <= 0) return null;
    const pct = (mkt.spotTokenPerEth - mkt.anchorTokenPerEth) / mkt.anchorTokenPerEth;
    if (pct >= this.strategyParams.upOnlySellPct) return "SELL";
    if (pct <= -this.strategyParams.downOnlyBuyPct) return "BUY";
    return null;
  }

  private pickUsdAmount(): number {
    const bucket = pickWeighted(
      this.strategyParams.usdBuckets.map((b) => ({ weight: b.weight, value: b }))
    );
    return randFloat(bucket.min, bucket.max);
  }

  private pickDelay(): number {
    const bucket = pickWeighted(
      this.strategyParams.intervalBuckets.map((b) => ({ weight: b.weight, value: b }))
    );
    return randInt(bucket.min, bucket.max);
  }

  private pickSlippage(side: Side): number {
    const r = side === "BUY" ? this.strategyParams.buySlip : this.strategyParams.sellSlip;
    return randFloat(r.min, r.max);
  }
}

