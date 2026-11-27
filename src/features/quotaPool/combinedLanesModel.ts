import type { PoolProviderId, PoolReset, PoolTrace } from '@/domain/quotaPool/types';
import { metricField, type ChartMode, type ChartSample } from './chartGeometry';
import { formatPoolNumber } from './presentation';

export type LaneTrace = PoolTrace & {
  provider: PoolProviderId;
  sourceLabel?: string;
  instanceId?: string;
  displayName?: string;
  /** Retired/disabled provider: history only; projected zeros align totals and are never drawn. */
  historyOnly?: true;
};

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

export function formatGainLabel(gainPoints: number, locale: string, compact: boolean): string {
  if (compact && gainPoints >= 10_000) {
    const compactNum = new Intl.NumberFormat(locale, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(gainPoints);
    return `+${compactNum}`;
  }
  return `+${formatPoolNumber(gainPoints, locale)}`;
}

export interface PlacedLaneReset {
  atMs: number;
  gainPoints: number;
  rx: number;
  text: string;
  labelX: number;
  labelLeft: number;
  labelRight: number;
  anchor: 'start' | 'end';
  showLabel: boolean;
}

/** Place per-lane reset ticks and non-overlapping gain labels (flipping left near right edge). */
export function placeLaneResets(
  resets: readonly PoolReset[],
  fromMs: number,
  toMs: number,
  x: (atMs: number) => number,
  right: number,
  locale: string,
  compact: boolean
): PlacedLaneReset[] {
  const byTime = new Map<number, number>();
  for (const reset of resets) {
    if (reset.atMs < fromMs || reset.atMs > toMs || reset.gainPoints <= 0) continue;
    byTime.set(reset.atMs, (byTime.get(reset.atMs) ?? 0) + reset.gainPoints);
  }
  const sorted = [...byTime.entries()].sort(([a], [b]) => a - b);
  let lastLabelRight = -Infinity;
  return sorted.map(([atMs, gainPoints]) => {
    const rx = x(atMs);
    const text = formatGainLabel(gainPoints, locale, compact);
    const estWidth = text.length * 6.2;
    const flipLeft = rx + 5 + estWidth > right;
    const labelX = flipLeft ? rx - 5 : rx + 5;
    const labelLeft = flipLeft ? labelX - estWidth : labelX;
    const labelRight = labelLeft + estWidth;
    const showLabel = labelLeft >= lastLabelRight + 8;
    if (showLabel) lastLabelRight = labelRight;
    return {
      atMs,
      gainPoints,
      rx,
      text,
      labelX,
      labelLeft,
      labelRight,
      anchor: flipLeft ? 'end' : 'start',
      showLabel,
    };
  });
}

export interface PlacedTotalTick {
  atMs: number;
  provider: PoolProviderId;
  label: string;
  gainPoints: number;
  x: number;
}

/** Top-edge provider-colored reset ticks on the Total plot; offsets simultaneous resets slightly. */
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
    for (const [atMs, gainPoints] of byTime) {
      raw.push({ atMs, provider: lane.provider, label: labelOf(lane), gainPoints, baseX: x(atMs) });
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
}

export interface LanesLayout {
  width: number;
  height: number;
  left: number;
  right: number;
  totalBox: PlotBox | null;
  laneBoxes: (PlotBox & { captionY: number })[];
  axisY: number;
}

/** Vertical stacking of the Total plot and synchronized provider lanes inside one SVG. */
export function computeLanesLayout({
  width,
  minimized,
  hasTotal,
  visibleLaneCount,
  labelChars,
}: {
  width: number;
  minimized: boolean;
  hasTotal: boolean;
  visibleLaneCount: number;
  labelChars: number;
}): LanesLayout {
  const narrow = width < 600;
  const left = Math.max(narrow ? 44 : 56, Math.ceil(labelChars * 8.4) + 16);
  const right = Math.max(left + 80, width - 12);
  const topPad = 36;
  const bottomPad = 34;

  // Minimized with Total (or a single standalone lane without Total): compact 160px single plot.
  if (minimized && (hasTotal || visibleLaneCount === 1)) {
    const height = 160;
    const box: PlotBox = {
      width,
      height,
      left,
      right,
      top: topPad,
      bottom: height - bottomPad,
    };
    return {
      width,
      height,
      left,
      right,
      totalBox: hasTotal ? box : null,
      laneBoxes: !hasTotal && visibleLaneCount === 1 ? [{ ...box, captionY: 16 }] : [],
      axisY: box.bottom + 24,
    };
  }

  // Single full-height plot: either Total-only (one provider, no duplicate lane) or one lane without Total.
  if ((hasTotal && visibleLaneCount === 0) || (!hasTotal && visibleLaneCount === 1)) {
    const plotHeight = narrow ? 164 : 204;
    const top = topPad;
    const bottom = top + plotHeight;
    const height = bottom + bottomPad;
    const box: PlotBox = { width, height, left, right, top, bottom };
    return {
      width,
      height,
      left,
      right,
      totalBox: hasTotal ? box : null,
      laneBoxes: hasTotal ? [] : [{ ...box, captionY: top - 16 }],
      axisY: bottom + 24,
    };
  }

  let cursorY = topPad;
  let totalBox: PlotBox | null = null;
  if (hasTotal) {
    const totalPlotH = narrow ? 104 : 156;
    totalBox = {
      width,
      height: 0,
      left,
      right,
      top: cursorY,
      bottom: cursorY + totalPlotH,
    };
    cursorY = totalBox.bottom + (narrow ? 12 : 16);
  }

  const captionH = 20;
  const lanePlotH = minimized ? 28 : visibleLaneCount >= 5 ? 30 : narrow ? 38 : 48;
  const laneGap = narrow ? 10 : 12;
  const laneBoxes: (PlotBox & { captionY: number })[] = [];
  for (let i = 0; i < visibleLaneCount; i += 1) {
    const captionY = cursorY + 13;
    const top = cursorY + captionH;
    const bottom = top + lanePlotH;
    laneBoxes.push({ width, height: 0, left, right, top, bottom, captionY });
    cursorY = bottom + (i < visibleLaneCount - 1 ? laneGap : 0);
  }

  const height = cursorY + bottomPad;
  if (totalBox) totalBox.height = height;
  for (const laneBox of laneBoxes) laneBox.height = height;
  return {
    width,
    height,
    left,
    right,
    totalBox,
    laneBoxes,
    axisY: cursorY + 24,
  };
}
