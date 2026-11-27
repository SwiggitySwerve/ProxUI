import type { PoolProviderId, PoolTrace } from '@/domain/quotaPool/types';
import { metricField, type ChartMode, type ChartSample } from './chartGeometry';
import { poolKey } from './poolOrder';

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

export function collectScheduledResets(
  lanes: readonly LaneTrace[],
  fromMs: number,
  toMs: number,
  labelOf: (lane: LaneTrace) => string
) {
  return lanes
    .flatMap((lane) =>
      lane.historyOnly
        ? []
        : lane.resets
            .filter((r) => r.atMs >= fromMs && r.atMs <= toMs && r.gainPoints > 0)
            .map((r) => ({
              atMs: r.atMs,
              gainPoints: r.gainPoints,
              provider: lane.provider,
              label: labelOf(lane),
            }))
    )
    .sort((a, b) => a.atMs - b.atMs);
}

export function describeCombinedStop({
  stop,
  isLatest,
  hasTotal,
  lanes,
  unit,
  laneLabel,
  date,
  number,
  labels,
}: {
  stop: LaneStop | undefined;
  isLatest: boolean;
  hasTotal: boolean;
  lanes: readonly LaneTrace[];
  unit: string;
  laneLabel: (lane: LaneTrace) => string;
  date: (ms: number) => string;
  number: (value: number | null) => string;
  labels: {
    inspectHint: string;
    latestReading: string;
    projected: string;
    total: string;
    noObservation: string;
  };
}): string {
  if (!stop) return labels.inspectHint;
  const head =
    isLatest && !stop.projected
      ? `${labels.latestReading} · ${date(stop.atMs)}`
      : `${date(stop.atMs)}${stop.projected ? ` · ${labels.projected}` : ''}`;
  const parts = [head];
  if (hasTotal && stop.totalAfter !== null) {
    parts.push(`${labels.total}: ${number(stop.totalAfter)}\u00a0${unit}`);
  }
  lanes.forEach((lane, index) => {
    if (lane.historyOnly && stop.projected) return;
    const val = stop.lanes[index];
    if (!val?.present) return;
    const reset = stop.resets.find((r) => r.laneIndex === index);
    const reading = val.after === null ? labels.noObservation : `${number(val.after)}\u00a0${unit}`;
    parts.push(`${laneLabel(lane)}: ${reading}${reset ? ` (+${number(reset.gainPoints)})` : ''}`);
  });
  return parts.join(' · ');
}

export interface NormalizedPercent {
  rawPct: number;
  /** Clamped to [0, 100] so curves, scrub dots, and cards share one fixed 0–100% scale. */
  plotPct: number;
  overflow: boolean;
}

const OVERFLOW_EPSILON = 1e-6;

/** Single display rule for normalized remaining quota across curves, scrub dots, cards, and readouts. */
export function normalizePercentValue(
  value: number | null,
  capacityPoints: number
): NormalizedPercent | null {
  if (value === null || !(capacityPoints > 0)) return null;
  const rawPct = (value / capacityPoints) * 100;
  const overflow = rawPct > 100 + OVERFLOW_EPSILON;
  return {
    rawPct,
    plotPct: Math.max(0, Math.min(100, rawPct)),
    overflow,
  };
}

export function formatNormalizedPercentLabel(norm: NormalizedPercent): string {
  return norm.overflow ? '>100%' : `${Math.round(norm.plotPct)}%`;
}

export function sampleHasOverflow(
  samples: readonly ChartSample[],
  capacityPoints: number,
  fromMs: number,
  toMs: number
): boolean {
  if (!(capacityPoints > 0)) return false;
  return samples.some(
    (sample) =>
      sample.point.atMs >= fromMs &&
      sample.point.atMs <= toMs &&
      normalizePercentValue(sample.point.remainingPoints, capacityPoints)?.overflow === true
  );
}

export function overflowMarkerXs(
  samples: readonly ChartSample[],
  capacityPoints: number,
  fromMs: number,
  toMs: number,
  x: (atMs: number) => number,
  minSpacingPx = 10
): number[] {
  if (!(capacityPoints > 0)) return [];
  const xs: number[] = [];
  for (const sample of samples) {
    if (sample.point.atMs < fromMs || sample.point.atMs > toMs) continue;
    const norm = normalizePercentValue(sample.point.remainingPoints, capacityPoints);
    if (!norm?.overflow) continue;
    const cx = x(sample.point.atMs);
    if (!xs.length || Math.abs(cx - xs[xs.length - 1]) >= minSpacingPx) xs.push(cx);
  }
  return xs;
}

/**
 * Use fixed 0–100% when plotted remaining traces have valid capacity denominators; fall back to a
 * clearly labeled points axis for all-dormant Totals or spotlighted zero-capacity pools.
 */
export function shouldUsePercentScale({
  isRemaining,
  totalSeries,
  totalSamples,
  laneSets,
  focusKeys,
  hasFocus,
  requireAllLanesPlotted = false,
}: {
  isRemaining: boolean;
  totalSeries: Pick<PoolTrace, 'capacityPoints'> | undefined;
  totalSamples: readonly ChartSample[];
  laneSets: readonly {
    key: string;
    lane: Pick<LaneTrace, 'capacityPoints'>;
    visibleSamples: readonly ChartSample[];
  }[];
  focusKeys: ReadonlySet<string>;
  hasFocus: boolean;
  /** True when minimized without Total so every listed provider trace must render on one scale. */
  requireAllLanesPlotted?: boolean;
}): boolean {
  if (!isRemaining) return false;
  const hasRemaining = (samples: readonly ChartSample[]) =>
    samples.some((sample) => sample.point.remainingPoints !== null);
  const totalHasValues = Boolean(totalSeries && hasRemaining(totalSamples));
  const totalMissingCap = totalHasValues && !(totalSeries!.capacityPoints > 0);
  if (totalMissingCap) return false;
  const focusedMissingCap =
    hasFocus &&
    laneSets.some(
      (set) =>
        focusKeys.has(set.key) && !(set.lane.capacityPoints > 0) && hasRemaining(set.visibleSamples)
    );
  if (focusedMissingCap) return false;
  const anyValuedMissingCap = laneSets.some(
    (set) => !(set.lane.capacityPoints > 0) && hasRemaining(set.visibleSamples)
  );
  if (requireAllLanesPlotted && anyValuedMissingCap) return false;
  const anyValuedHasCap =
    (totalHasValues && totalSeries!.capacityPoints > 0) ||
    laneSets.some((set) => set.lane.capacityPoints > 0 && hasRemaining(set.visibleSamples));
  return anyValuedHasCap || !anyValuedMissingCap;
}

/**
 * Convert remaining-quota samples to clamped 0–100% of `capacityPoints`, preserving nulls.
 * Inserts exact synthetic boundary crossings before clamping so segments descending from >100%
 * (or rising past 100%) preserve exact linear geometry below 100%.
 */
export function normalizeSamplesToPercent(
  samples: readonly ChartSample[],
  capacityPoints: number
): ChartSample[] {
  if (!(capacityPoints > 0)) return [];
  const out: ChartSample[] = [];
  let prev: { atMs: number; projected: boolean; rawPct: number } | null = null;
  for (const sample of samples) {
    const norm = normalizePercentValue(sample.point.remainingPoints, capacityPoints);
    if (!norm) {
      out.push({
        projected: sample.projected,
        point: { ...sample.point, remainingPoints: null },
      });
      prev = null;
      continue;
    }
    if (prev && prev.projected === sample.projected && sample.point.atMs > prev.atMs) {
      const crossings: number[] = [];
      for (const bound of [0, 100]) {
        if (
          (prev.rawPct < bound && norm.rawPct > bound) ||
          (prev.rawPct > bound && norm.rawPct < bound)
        ) {
          crossings.push(bound);
        }
      }
      // Order crossings along the direction of travel from prev.rawPct toward norm.rawPct.
      if (crossings.length === 2 && prev.rawPct > norm.rawPct) crossings.reverse();
      for (const bound of crossings) {
        const tCross =
          prev.atMs +
          ((bound - prev.rawPct) / (norm.rawPct - prev.rawPct)) * (sample.point.atMs - prev.atMs);
        out.push({
          projected: sample.projected,
          synthetic: true,
          point: { ...sample.point, atMs: tCross, remainingPoints: bound },
        });
      }
    }
    out.push({
      projected: sample.projected,
      ...(sample.synthetic ? { synthetic: true as const } : {}),
      point: { ...sample.point, remainingPoints: norm.plotPct },
    });
    prev = { atMs: sample.point.atMs, projected: sample.projected, rawPct: norm.rawPct };
  }
  return out;
}

export {
  buildSpreadPaths,
  computeSpreadBand,
  type SpreadBandResult,
  type SpreadPoint,
  type SpreadRun,
  type SpreadSvgPaths,
} from './combinedSpreadBand';

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
    const key = poolKey(lane);
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
