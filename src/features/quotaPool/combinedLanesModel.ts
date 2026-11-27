import type { PoolProviderId, PoolTrace } from '@/domain/quotaPool/types';
import { metricField, type ChartMode, type ChartSample } from './chartGeometry';

export type LaneTrace = PoolTrace & {
  provider: PoolProviderId;
  sourceLabel?: string;
  instanceId?: string;
  displayName?: string;
  /** Retired/disabled provider: history only; projected zeros align totals and are never drawn. */
  historyOnly?: true;
};

export type CombinedBackgroundMode = 'smart' | 'ghost';

export const COMBINED_BACKGROUND_STORAGE_KEY = 'quotaPool.combinedBackgroundMode';
export const SMART_BAND_THRESHOLD = 5;

export function parseCombinedBackgroundMode(raw: string | null): CombinedBackgroundMode {
  return raw === 'ghost' ? 'ghost' : 'smart';
}

export function readCombinedBackgroundMode(): CombinedBackgroundMode {
  try {
    if (typeof window === 'undefined') return 'smart';
    return parseCombinedBackgroundMode(
      window.localStorage.getItem(COMBINED_BACKGROUND_STORAGE_KEY)
    );
  } catch {
    return 'smart';
  }
}

export function writeCombinedBackgroundMode(mode: CombinedBackgroundMode): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(COMBINED_BACKGROUND_STORAGE_KEY, mode);
  } catch {
    // Storage can be blocked or full; the page still works, it just forgets.
  }
}

export function laneIdentity(lane: Pick<LaneTrace, 'provider' | 'instanceId'>): string {
  return lane.instanceId ?? lane.provider;
}

export interface LaneStopReset {
  laneIndex: number;
  provider: PoolProviderId;
  label: string;
  atMs: number;
  gainPoints: number;
  before: number | null;
  after: number | null;
}

export interface LaneStop {
  atMs: number;
  projected: boolean;
  totalBefore: number | null;
  totalAfter: number | null;
  /** One entry per lane in `lanes` order; null when absent or historyOnly during projection. */
  lanes: { before: number | null; after: number | null; present: boolean }[];
  resets: LaneStopReset[];
}

export interface StopKey {
  atMs: number;
  projected: boolean;
}

interface SeriesValue {
  before: number | null;
  after: number | null;
  present: boolean;
}

function indexSeries(
  samples: readonly ChartSample[],
  mode: ChartMode,
  skipProjected = false,
  fromMs?: number,
  toMs?: number
) {
  const field = metricField[mode];
  const map = new Map<string, { atMs: number; projected: boolean; value: SeriesValue }>();
  for (const sample of samples) {
    if (skipProjected && sample.projected) continue;
    if (fromMs !== undefined && sample.point.atMs < fromMs) continue;
    if (toMs !== undefined && sample.point.atMs > toMs) continue;
    const key = `${sample.point.atMs}:${sample.projected ? 1 : 0}`;
    const value = sample.point[field];
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        atMs: sample.point.atMs,
        projected: sample.projected,
        value: { before: value, after: value, present: true },
      });
    } else {
      existing.value.after = value;
    }
  }
  return map;
}

/**
 * Distinct chronological inspection stops across Total and all provider lanes.
 * Collapses before/after duplicate timestamps from `alignProjections` into one stop carrying
 * both sides and exact server-supplied `gainPoints` so arrows never stall and resets read clearly.
 * Restricts stops to `[fromMs, toMs]` when provided so clipping neighbors stay unselectable.
 */
export function buildLaneStops({
  totalSamples,
  laneSamples,
  lanes,
  mode,
  fromMs,
  toMs,
  labelOf,
}: {
  totalSamples: readonly ChartSample[];
  laneSamples: readonly (readonly ChartSample[])[];
  lanes: readonly LaneTrace[];
  mode: ChartMode;
  fromMs?: number;
  toMs?: number;
  labelOf: (lane: LaneTrace) => string;
}): LaneStop[] {
  const totalMap = indexSeries(totalSamples, mode, false, fromMs, toMs);
  const laneMaps = laneSamples.map((samples, index) =>
    indexSeries(samples, mode, Boolean(lanes[index]?.historyOnly), fromMs, toMs)
  );

  const keys = new Map<string, { atMs: number; projected: boolean }>();
  for (const [key, entry] of totalMap)
    keys.set(key, { atMs: entry.atMs, projected: entry.projected });
  for (const map of laneMaps) {
    for (const [key, entry] of map) keys.set(key, { atMs: entry.atMs, projected: entry.projected });
  }

  const ordered = [...keys.entries()].sort(
    ([, a], [, b]) => a.atMs - b.atMs || Number(a.projected) - Number(b.projected)
  );

  const stops: LaneStop[] = [];
  for (const [key, { atMs, projected }] of ordered) {
    const totalEntry = totalMap.get(key)?.value;
    const laneValues = laneMaps.map(
      (map) => map.get(key)?.value ?? { before: null, after: null, present: false }
    );
    const resets: LaneStopReset[] = [];
    if (mode === 'remaining' && projected) {
      lanes.forEach((lane, laneIndex) => {
        if (lane.historyOnly) return;
        const matching = lane.resets.filter((r) => r.atMs === atMs && r.gainPoints > 0);
        if (!matching.length) return;
        const gainPoints = matching.reduce((sum, r) => sum + r.gainPoints, 0);
        const lv = laneValues[laneIndex];
        resets.push({
          laneIndex,
          provider: lane.provider,
          label: labelOf(lane),
          atMs,
          gainPoints,
          before: lv.before,
          after: lv.after,
        });
      });
    }
    const stop: LaneStop = {
      atMs,
      projected,
      totalBefore: totalEntry?.before ?? null,
      totalAfter: totalEntry?.after ?? null,
      lanes: laneValues,
      resets,
    };
    // Avoid a redundant no-op stop right at `nowMs` where recorded ends and projected starts with
    // identical values and no reset jump.
    const prev = stops[stops.length - 1];
    if (
      prev &&
      !prev.projected &&
      stop.projected &&
      prev.atMs === stop.atMs &&
      stop.resets.length === 0 &&
      prev.totalAfter === stop.totalAfter &&
      prev.lanes.every((pl, i) => pl.after === stop.lanes[i].after)
    ) {
      continue;
    }
    stops.push(stop);
  }
  return stops;
}

export function latestRecordedStopIndex(stops: readonly LaneStop[], nowMs: number): number {
  let latest = -1;
  for (let i = 0; i < stops.length; i += 1) {
    if (!stops[i].projected && stops[i].atMs <= nowMs) latest = i;
  }
  return latest >= 0 ? latest : 0;
}

/** True when two visible sample sequences draw the exact same known points for `mode`. */
export function sameVisibleTrace(
  a: readonly ChartSample[],
  b: readonly ChartSample[],
  mode: ChartMode
): boolean {
  const field = metricField[mode];
  const knownA = a.filter((sample) => sample.point[field] !== null);
  const knownB = b.filter((sample) => sample.point[field] !== null);
  if (knownA.length !== knownB.length) return false;
  return knownA.every(
    (sample, index) =>
      sample.projected === knownB[index].projected &&
      sample.point.atMs === knownB[index].point.atMs &&
      sample.point[field] === knownB[index].point[field]
  );
}

/** Resolve a pinned or hovered stop identity across polling refreshes without index drift. */
export function resolveStopIndex(
  stops: readonly LaneStop[],
  key: StopKey | null,
  fromMs?: number,
  toMs?: number
): number | null {
  if (!key || !stops.length) return null;
  if ((fromMs !== undefined && key.atMs < fromMs) || (toMs !== undefined && key.atMs > toMs)) {
    return null;
  }
  const exact = stops.findIndex(
    (stop) => stop.atMs === key.atMs && stop.projected === key.projected
  );
  if (exact >= 0) return exact;
  const sameTime = stops.findIndex((stop) => stop.atMs === key.atMs);
  if (sameTime >= 0) return sameTime;
  let closest = 0;
  let closestDist = Math.abs(stops[0].atMs - key.atMs);
  for (let i = 1; i < stops.length; i += 1) {
    const dist = Math.abs(stops[i].atMs - key.atMs);
    if (dist < closestDist) {
      closest = i;
      closestDist = dist;
    }
  }
  return closest;
}

/** 1D horizontal scrub selection with magnetic snap to scheduled resets within `snapPx`. */
export function selectStopAtX(
  stops: readonly LaneStop[],
  cursorX: number,
  x: (atMs: number) => number,
  snapPx = 12
): number {
  if (!stops.length) return 0;
  let closest = 0;
  let closestDist = Math.abs(x(stops[0].atMs) - cursorX);
  let closestReset = -1;
  let closestResetDist = Infinity;
  for (let i = 0; i < stops.length; i += 1) {
    const dist = Math.abs(x(stops[i].atMs) - cursorX);
    if (dist <= closestDist) {
      closest = i;
      closestDist = dist;
    }
    if (stops[i].resets.length > 0 && dist <= snapPx && dist < closestResetDist) {
      closestReset = i;
      closestResetDist = dist;
    }
  }
  return closestReset >= 0 ? closestReset : closest;
}

export function nextResetStopIndex(
  stops: readonly LaneStop[],
  currentIndex: number,
  direction: -1 | 1
): number | null {
  for (let i = currentIndex + direction; i >= 0 && i < stops.length; i += direction) {
    if (stops[i].resets.length > 0) return i;
  }
  return null;
}

export interface NextResetSummary {
  atMs: number;
  items: { provider: PoolProviderId; label: string; gainPoints: number }[];
}

/** Earliest scheduled reset with positive gain across all active lanes within the visible span. */
export function findNextReset(
  lanes: readonly LaneTrace[],
  nowMs: number,
  toMs: number,
  labelOf: (lane: LaneTrace) => string
): NextResetSummary | null {
  let earliestAt = Infinity;
  for (const lane of lanes) {
    if (lane.historyOnly) continue;
    for (const reset of lane.resets) {
      if (reset.gainPoints > 0 && reset.atMs >= nowMs && reset.atMs <= toMs) {
        if (reset.atMs < earliestAt) earliestAt = reset.atMs;
      }
    }
  }
  if (!Number.isFinite(earliestAt)) return null;
  const items: NextResetSummary['items'] = [];
  for (const lane of lanes) {
    if (lane.historyOnly) continue;
    const gainPoints = lane.resets
      .filter((r) => r.atMs === earliestAt && r.gainPoints > 0)
      .reduce((sum, r) => sum + r.gainPoints, 0);
    if (gainPoints > 0) {
      items.push({ provider: lane.provider, label: labelOf(lane), gainPoints });
    }
  }
  return items.length ? { atMs: earliestAt, items } : null;
}

/** Convert remaining-quota samples to % of `capacityPoints`, preserving nulls and zero-division safety. */
export function normalizeSamplesToPercent(
  samples: readonly ChartSample[],
  capacityPoints: number
): ChartSample[] {
  if (!(capacityPoints > 0)) return [];
  return samples.map((sample) => ({
    projected: sample.projected,
    point: {
      ...sample.point,
      remainingPoints:
        sample.point.remainingPoints === null
          ? null
          : (sample.point.remainingPoints / capacityPoints) * 100,
    },
  }));
}

export interface SpreadPoint {
  atMs: number;
  minPct: number;
  maxPct: number;
}

/**
 * Continuous min–max % spread runs across active provider traces.
 * Evaluates only at timestamps where >= 2 eligible providers report numeric values (never
 * fabricates across gaps) and excludes `historyOnly` providers from projected spread.
 */
export function computeSpreadBand(
  normalizedLanes: readonly (readonly ChartSample[])[],
  lanes: readonly Pick<LaneTrace, 'historyOnly'>[]
): SpreadPoint[][] {
  const byEvent = new Map<
    string,
    { atMs: number; projected: boolean; side: number; values: number[] }
  >();
  normalizedLanes.forEach((samples, laneIdx) => {
    const historyOnly = Boolean(lanes[laneIdx]?.historyOnly);
    const seenAt = new Map<string, number>();
    for (const sample of samples) {
      if (historyOnly && sample.projected) continue;
      const baseKey = `${sample.point.atMs}:${sample.projected ? 1 : 0}`;
      const side = seenAt.get(baseKey) ?? 0;
      seenAt.set(baseKey, side + 1);
      const val = sample.point.remainingPoints;
      const eventKey = `${baseKey}:${side}`;
      let bucket = byEvent.get(eventKey);
      if (!bucket) {
        bucket = { atMs: sample.point.atMs, projected: sample.projected, side, values: [] };
        byEvent.set(eventKey, bucket);
      }
      if (val !== null) bucket.values.push(val);
    }
  });

  const ordered = [...byEvent.values()].sort(
    (a, b) => a.atMs - b.atMs || Number(a.projected) - Number(b.projected) || a.side - b.side
  );

  const runs: SpreadPoint[][] = [];
  let current: SpreadPoint[] = [];
  for (const entry of ordered) {
    if (entry.values.length >= 2) {
      current.push({
        atMs: entry.atMs,
        minPct: Math.min(...entry.values),
        maxPct: Math.max(...entry.values),
      });
    } else {
      if (current.length >= 2) runs.push(current);
      current = [];
    }
  }
  if (current.length >= 2) runs.push(current);
  return runs;
}

export interface PlacedTotalTick {
  atMs: number;
  provider: PoolProviderId;
  laneKey: string;
  label: string;
  gainPoints: number;
  x: number;
}

/** Top-edge provider-colored reset ticks; offsets simultaneous resets slightly. */
export function placeTotalResetTicks(
  lanes: readonly LaneTrace[],
  fromMs: number,
  toMs: number,
  x: (atMs: number) => number,
  labelOf: (lane: LaneTrace) => string
): PlacedTotalTick[] {
  const raw: {
    atMs: number;
    provider: PoolProviderId;
    laneKey: string;
    label: string;
    gainPoints: number;
    baseX: number;
  }[] = [];
  for (const lane of lanes) {
    if (lane.historyOnly) continue;
    const byTime = new Map<number, number>();
    for (const reset of lane.resets) {
      if (reset.atMs < fromMs || reset.atMs > toMs || reset.gainPoints <= 0) continue;
      byTime.set(reset.atMs, (byTime.get(reset.atMs) ?? 0) + reset.gainPoints);
    }
    const key = laneIdentity(lane);
    for (const [atMs, gainPoints] of byTime) {
      raw.push({
        atMs,
        provider: lane.provider,
        laneKey: key,
        label: labelOf(lane),
        gainPoints,
        baseX: x(atMs),
      });
    }
  }
  raw.sort((a, b) => a.baseX - b.baseX);
  const clusters: (typeof raw)[] = [];
  for (const item of raw) {
    const last = clusters[clusters.length - 1];
    if (last && item.baseX - last[0].baseX <= 3) last.push(item);
    else clusters.push([item]);
  }
  const placed: PlacedTotalTick[] = [];
  for (const cluster of clusters) {
    const spread = 3;
    const offsetStart = -((cluster.length - 1) * spread) / 2;
    cluster.forEach((item, index) => {
      placed.push({
        atMs: item.atMs,
        provider: item.provider,
        laneKey: item.laneKey,
        label: item.label,
        gainPoints: item.gainPoints,
        x: item.baseX + offsetStart + index * spread,
      });
    });
  }
  return placed;
}

export interface PlotBox {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  axisY: number;
}

/** Constant-height single plot frame that scales cleanly to any provider count. */
export function computeHybridFrame({
  width,
  minimized,
  leftChars,
  rightChars = 0,
}: {
  width: number;
  minimized: boolean;
  leftChars: number;
  rightChars?: number;
}): PlotBox {
  const narrow = width < 600;
  const height = minimized ? 160 : narrow ? 216 : 244;
  const left = Math.max(narrow ? 42 : 48, Math.ceil(leftChars * 8.2) + 14);
  const rightMargin = rightChars > 0 ? Math.max(46, Math.ceil(rightChars * 7.6) + 14) : 12;
  const right = Math.max(left + 80, width - rightMargin);
  const top = 34;
  const bottom = height - 32;
  return {
    width,
    height,
    left,
    right,
    top,
    bottom,
    axisY: bottom + 22,
  };
}
