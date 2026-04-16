import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Contract } from "ethers";
import { PoolManager } from "../src/bot/pool-manager.js";
import { defaultConfig } from "../src/bot/config.js";
import { getProvider } from "../src/bot/get-provider.js";

const V3_POOL_OBSERVATION_READ_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function observations(uint256 index) view returns (uint32 blockTimestamp,int56 tickCumulative,uint160 secondsPerLiquidityCumulativeX128,bool initialized)",
] as const;

type RawObservation = {
  index: number;
  blockTimestamp: number;
  tickCumulative: bigint;
  secondsPerLiquidityCumulativeX128: bigint;
  initialized: boolean;
};

type TimePricePoint = {
  fromIndex: number;
  toIndex: number;
  fromTimestamp: number;
  toTimestamp: number;
  timeIso: string;
  dtSec: number;
  avgTick: number;
  priceToken1PerToken0: number;
  priceToken0PerToken1: number;
  /** Percentage change of token0/token1 price vs previous point. */
  priceChangePctVsPrev: number | null;
};

function toIso(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString();
}

function safeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Read all initialized observations within current observationCardinality.
 */
export async function getAllObservations(poolIndex: number): Promise<{
  poolAddress: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  observationIndex: number;
  observationCardinality: number;
  observationCardinalityNext: number;
  observations: RawObservation[];
}> {
  const bootstrapProvider = getProvider(defaultConfig().rpcUrl);
  const pm = PoolManager.load(console, bootstrapProvider);
  const poolCfg = pm.getPool(poolIndex);

  const provider = getProvider(poolCfg.rpcUrl);
  const pool = new Contract(poolCfg.poolAddress, V3_POOL_OBSERVATION_READ_ABI, provider);

  const slot0 = await pool.slot0() as readonly [bigint, number, number, number, number, number, boolean];
  const observationIndex = Number(slot0[2]);
  const observationCardinality = Number(slot0[3]);
  const observationCardinalityNext = Number(slot0[4]);

  const obsCalls: Array<Promise<readonly [number, bigint, bigint, boolean]>> = [];
  for (let i = 0; i < observationCardinality; i += 1) {
    obsCalls.push(pool.observations(i) as Promise<readonly [number, bigint, bigint, boolean]>);
  }
  const all = await Promise.all(obsCalls);

  const observations: RawObservation[] = all.map((obs, idx) => ({
    index: idx,
    blockTimestamp: Number(obs[0]),
    tickCumulative: BigInt(obs[1] as unknown as bigint),
    secondsPerLiquidityCumulativeX128: BigInt(obs[2] as unknown as bigint),
    initialized: Boolean(obs[3]),
  })).filter((o) => o.initialized);

  // For practical usage here, timestamp wrap is unlikely; sorting gives chronological order.
  observations.sort((a, b) => a.blockTimestamp - b.blockTimestamp);

  return {
    poolAddress: poolCfg.poolAddress,
    token0Symbol: poolCfg.token0Info.symbol,
    token1Symbol: poolCfg.token1Info.symbol,
    token0Decimals: Number(poolCfg.token0Info.decimals),
    token1Decimals: Number(poolCfg.token1Info.decimals),
    observationIndex,
    observationCardinality,
    observationCardinalityNext,
    observations,
  };
}

/**
 * Convert observations into interval points: (time, price) using avg tick between adjacent observations.
 */
export function observationsToTimePrice(
  observations: RawObservation[],
  token0Decimals: number,
  token1Decimals: number,
): TimePricePoint[] {
  const out: TimePricePoint[] = [];
  const decimalScale = 10 ** (token0Decimals - token1Decimals);

  for (let i = 1; i < observations.length; i += 1) {
    const prev = observations[i - 1]!;
    const cur = observations[i]!;
    const dtSec = cur.blockTimestamp - prev.blockTimestamp;
    if (dtSec <= 0) continue;

    const tickDelta = cur.tickCumulative - prev.tickCumulative;
    const avgTick = Number(tickDelta) / dtSec;
    const priceToken1PerToken0 = Math.pow(1.0001, avgTick) * decimalScale;
    const priceToken0PerToken1 = priceToken1PerToken0 === 0 ? 0 : 1 / priceToken1PerToken0;

    // Use token0/token1 as primary display price (e.g. GMB/WETH).
    const prevPrice = out.length ? out[out.length - 1]!.priceToken0PerToken1 : null;
    const priceChangePctVsPrev = prevPrice == null
      ? null
      : ((priceToken0PerToken1 - prevPrice) / prevPrice) * 100;

    out.push({
      fromIndex: prev.index,
      toIndex: cur.index,
      fromTimestamp: prev.blockTimestamp,
      toTimestamp: cur.blockTimestamp,
      timeIso: toIso(cur.blockTimestamp),
      dtSec,
      avgTick,
      priceToken1PerToken0,
      priceToken0PerToken1,
      priceChangePctVsPrev,
    });
  }

  return out;
}

function buildChartHtml(args: {
  poolAddress: string;
  token0Symbol: string;
  token1Symbol: string;
  observationIndex: number;
  observationCardinality: number;
  observationCardinalityNext: number;
  points: TimePricePoint[];
}) {
  const labels = args.points.map((p) => p.timeIso);
  const series = args.points.map((p) => Number(p.priceToken0PerToken1.toFixed(10)));
  const changeSeries = args.points.map((p) =>
    p.priceChangePctVsPrev == null ? null : Number(p.priceChangePctVsPrev.toFixed(6))
  );

  const rows = args.points.map((p) => ({
    time: p.timeIso,
    fromIndex: p.fromIndex,
    toIndex: p.toIndex,
    dtSec: p.dtSec,
    avgTick: Number(p.avgTick.toFixed(4)),
    priceToken1PerToken0: Number(p.priceToken1PerToken0.toFixed(10)),
    priceToken0PerToken1: Number(p.priceToken0PerToken1.toFixed(10)),
    priceChangePctVsPrev: p.priceChangePctVsPrev == null ? null : Number(p.priceChangePctVsPrev.toFixed(6)),
  }));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Uniswap V3 Observations Chart</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; color: #111827; }
    h1 { margin: 0 0 10px; font-size: 22px; }
    .meta { margin: 0 0 18px; color: #4b5563; font-size: 14px; }
    .card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px; margin-bottom: 14px; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: right; }
    th:first-child, td:first-child { text-align: left; }
    code { background: #f3f4f6; padding: 2px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Pool Observations Price Chart</h1>
  <p class="meta">
    Pool: <code>${args.poolAddress}</code><br/>
    Pair: <code>${args.token0Symbol}/${args.token1Symbol}</code> |
    observationIndex=${args.observationIndex} |
    cardinality=${args.observationCardinality} |
    cardinalityNext=${args.observationCardinalityNext}
  </p>

  <div class="card">
    <canvas id="priceChart" height="120"></canvas>
  </div>
  <div class="card">
    <canvas id="changeChart" height="90"></canvas>
  </div>

  <div class="card">
    <h3 style="margin: 0 0 10px;">Computed (time, price) points</h3>
    <table>
      <thead>
        <tr>
          <th>time</th>
          <th>fromIndex</th>
          <th>toIndex</th>
          <th>dtSec</th>
          <th>avgTick</th>
          <th>${args.token0Symbol}/${args.token1Symbol}</th>
          <th>${args.token1Symbol}/${args.token0Symbol}</th>
          <th>change % vs prev</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>

  <script>
    const labels = ${JSON.stringify(safeJson(labels))};
    const series = ${JSON.stringify(safeJson(series))};
    const changeSeries = ${JSON.stringify(safeJson(changeSeries))};
    const rows = ${JSON.stringify(safeJson(rows))};

    const ctx1 = document.getElementById("priceChart");
    new Chart(ctx1, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "${args.token0Symbol} per ${args.token1Symbol}",
          data: series,
          borderColor: "#2563eb",
          backgroundColor: "rgba(37,99,235,0.15)",
          tension: 0.2,
          pointRadius: 2,
          fill: true
        }]
      },
      options: {
        responsive: true,
        scales: {
          x: { ticks: { maxTicksLimit: 10 } },
          y: { title: { display: true, text: "${args.token0Symbol}/${args.token1Symbol}" } }
        }
      }
    });

    const ctx2 = document.getElementById("changeChart");
    new Chart(ctx2, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Price change % vs previous point",
          data: changeSeries,
          borderColor: "#059669",
          backgroundColor: "rgba(5,150,105,0.35)"
        }]
      },
      options: {
        responsive: true,
        scales: {
          x: { ticks: { maxTicksLimit: 10 } },
          y: { title: { display: true, text: "%" } }
        }
      }
    });

    const tbody = document.getElementById("rows");
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = [
        r.time,
        r.fromIndex,
        r.toIndex,
        r.dtSec,
        r.avgTick,
        r.priceToken0PerToken1,
        r.priceToken1PerToken0,
        r.priceChangePctVsPrev ?? ""
      ].map((x) => "<td>" + x + "</td>").join("");
      tbody.appendChild(tr);
    });
  </script>
</body>
</html>`;
}

async function main() {
  const poolIndex = Number(process.env.POOL_INDEX ?? "0");
  if (!Number.isInteger(poolIndex) || poolIndex < 0) {
    throw new Error(`Invalid POOL_INDEX: ${process.env.POOL_INDEX}`);
  }

  const data = await getAllObservations(poolIndex);
  const points = observationsToTimePrice(
    data.observations,
    data.token0Decimals,
    data.token1Decimals,
  );

  console.log("Pool:", data.poolAddress);
  console.log("slot0.observationIndex:", data.observationIndex);
  console.log("slot0.observationCardinality:", data.observationCardinality);
  console.log("slot0.observationCardinalityNext:", data.observationCardinalityNext);
  console.log("initialized observations:", data.observations.length);
  console.log("computed time-price points:", points.length);

  const outDir = path.join(process.cwd(), "artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `pool-${poolIndex}-observations.json`);
  const htmlPath = path.join(outDir, `pool-${poolIndex}-observations-chart.html`);

  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      ...data,
      observations: data.observations.map((o) => ({
        ...o,
        tickCumulative: o.tickCumulative.toString(),
        secondsPerLiquidityCumulativeX128: o.secondsPerLiquidityCumulativeX128.toString(),
      })),
      points,
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    htmlPath,
    buildChartHtml({
      poolAddress: data.poolAddress,
      token0Symbol: data.token0Symbol,
      token1Symbol: data.token1Symbol,
      observationIndex: data.observationIndex,
      observationCardinality: data.observationCardinality,
      observationCardinalityNext: data.observationCardinalityNext,
      points,
    }),
    "utf8",
  );

  console.log("Wrote JSON:", jsonPath);
  console.log("Wrote chart HTML:", htmlPath);
  console.log("Open chart in browser to view.");
}

await main();
