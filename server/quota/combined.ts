import type { CombinedPoolResult, PoolPoint, QuotaPool } from '../../src/domain/quotaPool/types';
import { sumKnown } from './values';

/** A forecast is piecewise linear; duplicate timestamps preserve the two sides of a reset. */
function projectedBalance(points: PoolPoint[], atMs: number, beforeReset: boolean): number | null {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].atMs < atMs) lo = mid + 1;
    else hi = mid;
  }
  if (points[lo]?.atMs === atMs) {
    if (beforeReset) return points[lo].remainingPoints;
    while (points[lo + 1]?.atMs === atMs) lo++;
    return points[lo].remainingPoints;
  }
  const left = points[lo - 1];
  const right = points[lo];
  if (!left || !right || left.remainingPoints === null || right.remainingPoints === null)
    return null;
  return (
    left.remainingPoints +
    (right.remainingPoints - left.remainingPoints) * ((atMs - left.atMs) / (right.atMs - left.atMs))
  );
}

/** Add independent provider forecasts; never reroute demand between providers. */
export function alignProjections(traces: PoolPoint[][]): PoolPoint[][] {
  if (!traces.length || traces.some((trace) => !trace.length)) return [];
  const times = [...new Set(traces.flatMap((trace) => trace.map((point) => point.atMs)))].sort(
    (a, b) => a - b
  );
  const resets = new Set(
    traces.flatMap((trace) =>
      trace.flatMap((point, index) =>
        index > 0 && trace[index - 1].atMs === point.atMs ? [point.atMs] : []
      )
    )
  );
  const events = times.flatMap((atMs) =>
    (resets.has(atMs) ? [true, false] : [false]).map((beforeReset) => ({ atMs, beforeReset }))
  );
  return traces.map((trace) =>
    events.map(({ atMs, beforeReset }) => ({
      atMs,
      remainingPoints: projectedBalance(trace, atMs, beforeReset),
      burnPointsPerHour: null,
      drainPointsPerHour: null,
    }))
  );
}

function sumProjections(aligned: PoolPoint[][]): PoolPoint[] {
  return (aligned[0] ?? []).map((point, index) => ({
    ...point,
    remainingPoints: sumKnown(aligned.map((trace) => trace[index].remainingPoints)),
  }));
}
export function combineProjections(traces: PoolPoint[][]): PoolPoint[] {
  return sumProjections(alignProjections(traces));
}

/** Only distinct provider allowances are proven independent by the current source contract. */
export function combinedPools(
  pools: QuotaPool[],
  readRecorded: (eligible: QuotaPool[]) => PoolPoint[],
  readLayers?: (eligible: QuotaPool[], times: number[]) => PoolPoint[][]
): CombinedPoolResult {
  // A pool whose every account is disabled (a paused or retired source) has no balance or
  // forecast to add, but the history its accounts recorded still belongs on the chart.
  const dormant = pools.filter(
    (pool) =>
      pool.eligibleCount === 0 &&
      pool.accounts.length > 0 &&
      pool.accounts.every((account) => account.status === 'disabled')
  );
  const members = pools.filter(
    (pool) =>
      !dormant.includes(pool) && (pool.eligibleCount > 0 || pool.forecastState !== 'no-accounts')
  );
  // A provider with no limit in this window (e.g. weekly-only Codex, 5-hour) has no allowance to
  // add; leaving it in would hold the total at "collecting" and empty its history.
  const limited = members.filter((pool) => pool.forecastState !== 'no-limit');
  const eligible = limited.length ? limited : members;
  const charted = [...eligible, ...dormant];
  if (!charted.length) return { series: null, unavailableReason: 'no-accounts' };
  if (new Set(charted.map((pool) => pool.provider)).size !== charted.length)
    return { series: null, unavailableReason: 'ambiguous-sources' };
  const forecastState = !eligible.length
    ? 'no-accounts'
    : eligible.some((pool) => pool.forecastState === 'stale')
      ? 'stale'
      : eligible.some((pool) => pool.forecastState === 'partial')
        ? 'partial'
        : eligible.some((pool) => pool.forecastState !== 'ready')
          ? 'collecting'
          : 'ready';
  const projectedLayers =
    forecastState === 'ready' ? alignProjections(eligible.map((pool) => pool.projected)) : [];
  const projected = sumProjections(projectedLayers);
  // A live pool with no accounts to read (failed or empty inventory) leaves the total unknown; a
  // pool with no limit in this window has nothing to add and never does.
  const recorded = eligible.some(
    (pool) => pool.eligibleCount === 0 && pool.forecastState !== 'no-limit'
  )
    ? []
    : readRecorded(charted);
  const recordedLayers = readLayers?.(
    charted,
    recorded.map((point) => point.atMs)
  );
  const resets = new Map<number, number[]>();
  if (forecastState === 'ready')
    for (const pool of eligible)
      for (const reset of pool.resets) {
        resets.set(reset.atMs, [...(resets.get(reset.atMs) ?? []), reset.gainPoints]);
      }
  return {
    unavailableReason: null,
    ...(recordedLayers
      ? {
          layers: charted.map((pool, index) => ({
            ...(index < eligible.length ? {} : { historyOnly: true as const }),
            provider: pool.provider,
            ...(pool.displayName ? { displayName: pool.displayName } : {}),
            instanceId: pool.instanceId,
            sourceLabel: pool.sourceLabel,
            capacityPoints: pool.capacityPoints,
            remainingPoints: pool.remainingPoints,
            burnPointsPerHour: pool.burnPointsPerHour,
            drainPointsPerHour: pool.drainPointsPerHour,
            forecastState: pool.forecastState,
            resets: pool.resets,
            poolEmptyAtMs: pool.poolEmptyAtMs,
            recorded: recordedLayers[index],
            // A dormant pool has nothing ahead of it: zero on the live forecast's events, so the
            // stacked chart lines every layer up.
            projected:
              index < eligible.length
                ? (projectedLayers[index] ?? [])
                : projected.map((point) => ({ ...point, remainingPoints: 0 })),
          })),
        }
      : {}),
    series: {
      capacityPoints: sumKnown(eligible.map((pool) => pool.capacityPoints))!,
      // Only dormant pools: history without a live balance.
      remainingPoints: eligible.length
        ? sumKnown(eligible.map((pool) => pool.remainingPoints))
        : null,
      burnPointsPerHour: eligible.length
        ? sumKnown(eligible.map((pool) => pool.burnPointsPerHour))
        : null,
      drainPointsPerHour: eligible.length
        ? sumKnown(eligible.map((pool) => pool.drainPointsPerHour))
        : null,
      forecastState,
      // A failed inventory with no known members is unknown, never a zero-sized pool.
      recorded,
      projected,
      resets: [...resets]
        .sort(([a], [b]) => a - b)
        .map(([atMs, gains]) => ({ atMs, gainPoints: sumKnown(gains)! })),
      poolEmptyAtMs: projected.find((point) => point.remainingPoints === 0)?.atMs ?? null,
    },
  };
}
