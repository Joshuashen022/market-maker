import { expect } from "chai";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { defaultConfig } from "../src/bot/config.js";
import { StrategyState } from "../src/bot/strategy.js";
import type { MarketContext, Side } from "../src/bot/strategy.js";

function mkMktForced(side: Side): MarketContext {
  // forcedSide() uses anchor vs spot deviation:
  // pct = (spot-anchor)/anchor
  // pct >= upOnlySellPct => SELL
  // pct <= -downOnlyBuyPct => BUY
  const anchorTokenPerEth = 100;
  const nowSec = 1_700_000_000;
  if (side === "SELL") {
    return {
      nowSec,
      anchorTokenPerEth,
      spotTokenPerEth: 200, // +100% => definitely >= band
    };
  }
  return {
    nowSec,
    anchorTokenPerEth,
    spotTokenPerEth: 1, // -99% => definitely <= -band
  };
}

function inAnyRange(x: number, ranges: Array<{ min: number; max: number }>) {
  return ranges.some((r) => x >= r.min && x <= r.max);
}

function whichRange(x: number, ranges: Array<{ min: number; max: number }>): number {
  return ranges.findIndex((r) => x >= r.min && x <= r.max);
}

function withDeterministicMathRandom<T>(seed: number, fn: () => T): T {
  // Simple 32-bit LCG for stable tests across Node versions.
  let state = seed >>> 0;
  const prev = Math.random;
  Math.random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  try {
    return fn();
  } finally {
    Math.random = prev;
  }
}

describe("StrategyState.decide() config rules", function () {
  it("generates 1000 decisions, writes them locally, and matches defaultConfig constraints", function () {
    const cfg = defaultConfig();
    const s = new StrategyState(cfg);

    const mkt: MarketContext = {
      nowSec: 1_700_000_000,
      // no anchor => no forced side; pure strategy randomness + maxConsecutive rule
      anchorTokenPerEth: null,
      spotTokenPerEth: 100,
    };

    const usdRanges = cfg.amountUsd.map((b) => ({ min: b.minUsd, max: b.maxUsd }));
    const intervalRanges = cfg.intervals.map((b) => ({ min: b.minSec, max: b.maxSec }));

    const decisions = withDeterministicMathRandom(0xdecafbad, () => {
      const out = [];
      for (let i = 0; i < 1000; i++) out.push(s.decide(mkt, cfg.ethUsd));
      return out;
    });

    const sideCounts = { BUY: 0, SELL: 0 } as Record<Side, number>;
    const usdBucketCounts = new Array(cfg.amountUsd.length).fill(0);
    const intervalBucketCounts = new Array(cfg.intervals.length).fill(0);

    let violations = 0;
    let longestRun = 0;
    let runLen = 0;
    let lastSide: Side | null = null;

    for (const d of decisions) {
      sideCounts[d.side] += 1;

      const usdIdx = whichRange(d.usdAmount, usdRanges);
      const intIdx = whichRange(d.nextDelaySec, intervalRanges);
      if (usdIdx === -1) violations += 1;
      else usdBucketCounts[usdIdx] += 1;
      if (intIdx === -1) violations += 1;
      else intervalBucketCounts[intIdx] += 1;

      // ethAmount derived from usdAmount/ethUsd
      if (Math.abs(d.ethAmount - d.usdAmount / cfg.ethUsd) > 1e-12) violations += 1;

      // slippage must be within side range
      if (d.side === "BUY") {
        if (d.slippage < cfg.slippageBuyBpsMin / 10_000 || d.slippage > cfg.slippageBuyBpsMax / 10_000) {
          violations += 1;
        }
      } else {
        if (d.slippage < cfg.slippageSellBpsMin / 10_000 || d.slippage > cfg.slippageSellBpsMax / 10_000) {
          violations += 1;
        }
      }

      // Track longest consecutive same-side run (given current implementation's flip rule).
      if (lastSide === d.side) runLen += 1;
      else {
        lastSide = d.side;
        runLen = 1;
      }
      if (runLen > longestRun) longestRun = runLen;
    }

    const buyPct = cfg.buyWeight / (cfg.buyWeight + cfg.sellWeight);
    const observedBuyPct = sideCounts.BUY / decisions.length;

    const summary = {
      cfg: {
        buyWeight: cfg.buyWeight,
        sellWeight: cfg.sellWeight,
        maxConsecutiveSameSide: cfg.maxConsecutiveSameSide,
        amountUsd: cfg.amountUsd,
        intervals: cfg.intervals,
        slippage: {
          buy: [cfg.slippageBuyBpsMin, cfg.slippageBuyBpsMax],
          sell: [cfg.slippageSellBpsMin, cfg.slippageSellBpsMax],
        },
        ethUsd: cfg.ethUsd,
      },
      sampleSize: decisions.length,
      sideCounts,
      observedBuyPct,
      expectedBuyPct: buyPct,
      usdBucketCounts,
      intervalBucketCounts,
      longestRun,
      violations,
      decisions,
    };

    const outPath = resolve(process.cwd(), "test", "strategy.decisions.1000.json");
    writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");

    expect(violations, "all generated decisions should satisfy defaultConfig constraints").to.equal(0);
    // Current implementation flips when runLen >= maxConsecutiveSameSide - 1, so longest run is <= maxConsecutiveSameSide - 1.
    expect(longestRun).to.be.at.most(cfg.maxConsecutiveSameSide - 1);
    // Keep this loose to avoid brittleness while still catching big regressions.
    expect(Math.abs(observedBuyPct - buyPct)).to.be.at.most(0.05);
  });
});

