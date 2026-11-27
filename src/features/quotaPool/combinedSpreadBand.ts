import type { ChartSample } from './chartGeometry';
import type { LaneTrace } from './combinedLanesModel';

export interface SpreadPoint {
  atMs: number;
  minPct: number;
  maxPct: number;
}

export interface SpreadRun {
  projected: boolean;
  points: SpreadPoint[];
}

export interface SpreadBandResult {
  runs: SpreadRun[];
  /** True only when every visible eligible non-null segment and reading is covered by >= 2 overlapping lanes. */
  fullyCovered: boolean;
}

export interface SpreadSvgPaths {
  projected: boolean;
  fill: string;
  upper: string;
  lower: string;
}

interface LinearSegment {
  laneIdx: number;
  t0: number;
  v0: number;
  t1: number;
  v1: number;
}

function interpolateSegment(seg: LinearSegment, t: number): number {
  if (t <= seg.t0) return seg.v0;
  if (t >= seg.t1) return seg.v1;
  return seg.v0 + ((t - seg.t0) / (seg.t1 - seg.t0)) * (seg.v1 - seg.v0);
}

function envelopeBreakpoints(
  startVals: readonly number[],
  endVals: readonly number[],
  a: number,
  b: number,
  isUpper: boolean,
  out: number[]
): void {
  const n = startVals.length;
  const span = b - a;
  if (n < 2 || span <= 0) return;
  const sign = isUpper ? 1 : -1;
  const eps = 1e-9;

  // Start on the winning extreme at t = a; break ties by steepest winning slope.
  let curr = 0;
  for (let i = 1; i < n; i += 1) {
    const diff = (startVals[i] - startVals[curr]) * sign;
    if (
      diff > eps ||
      (Math.abs(diff) <= eps &&
        (endVals[i] - startVals[i] - (endVals[curr] - startVals[curr])) * sign > eps)
    ) {
      curr = i;
    }
  }

  let t = a;
  for (let guard = 0; guard < n; guard += 1) {
    const currStart = startVals[curr];
    const currDelta = endVals[curr] - currStart;
    let bestT = b;
    let bestIdx = -1;
    let bestDelta = 0;

    for (let j = 0; j < n; j += 1) {
      if (j === curr) continue;
      const jDelta = endVals[j] - startVals[j];
      const deltaDiff = (jDelta - currDelta) * sign;
      if (deltaDiff <= eps) continue;
      const u = ((currStart - startVals[j]) * sign) / deltaDiff;
      const tc = a + u * span;
      if (tc <= t + eps || tc >= b - eps) continue;
      if (tc < bestT - eps || (Math.abs(tc - bestT) <= eps && jDelta * sign > bestDelta * sign)) {
        bestT = tc;
        bestIdx = j;
        bestDelta = jDelta;
      }
    }

    if (bestIdx < 0) break;
    out.push(bestT);
    curr = bestIdx;
    t = bestT;
  }
}

/**
 * Sweep-line min–max % spread built strictly from overlapping, continuous provider segments
 * clipped to `[fromMs, toMs]` within each phase (`recorded` and `projected` separately).
 * Emits only true outer-envelope breakpoints (never interior lane crossings) and reports
 * `fullyCovered` only when every visible real observation is represented.
 */
export function computeSpreadBand(
  normalizedLanes: readonly (readonly ChartSample[])[],
  lanes: readonly Pick<LaneTrace, 'historyOnly'>[],
  fromMs?: number,
  toMs?: number
): SpreadBandResult {
  const runs: SpreadRun[] = [];
  let hasAnyEligibleValue = false;
  let hasUncovered = false;

  const inVisibleSpan = (atMs: number) =>
    (fromMs === undefined || atMs >= fromMs) && (toMs === undefined || atMs <= toMs);
  const segOverlapsVisible = (t0: number, t1: number) =>
    t1 > t0 && (fromMs === undefined || t1 > fromMs) && (toMs === undefined || t0 < toMs);

  for (const projected of [false, true]) {
    const startsByTime = new Map<number, LinearSegment[]>();
    const endsByTime = new Map<number, LinearSegment[]>();
    const timeSet = new Set<number>();

    normalizedLanes.forEach((samples, laneIdx) => {
      if (projected && lanes[laneIdx]?.historyOnly) return;
      const contiguous: { atMs: number; val: number; synthetic: boolean }[][] = [];
      let curRun: { atMs: number; val: number; synthetic: boolean }[] = [];
      for (const sample of samples) {
        if (sample.projected !== projected) continue;
        const val = sample.point.remainingPoints;
        if (val === null) {
          if (curRun.length) {
            contiguous.push(curRun);
            curRun = [];
          }
          continue;
        }
        curRun.push({ atMs: sample.point.atMs, val, synthetic: Boolean(sample.synthetic) });
      }
      if (curRun.length) contiguous.push(curRun);

      for (const run of contiguous) {
        const len = run.length;
        for (let i = 0; i < len; i += 1) {
          const curr = run[i];
          const prev = i > 0 ? run[i - 1] : null;
          const next = i + 1 < len ? run[i + 1] : null;
          const leftAttached = Boolean(prev && segOverlapsVisible(prev.atMs, curr.atMs));
          const rightAttached = Boolean(next && segOverlapsVisible(curr.atMs, next.atMs));

          if (inVisibleSpan(curr.atMs)) hasAnyEligibleValue = true;

          if (leftAttached && prev) {
            const rawSeg: LinearSegment = {
              laneIdx,
              t0: prev.atMs,
              v0: prev.val,
              t1: curr.atMs,
              v1: curr.val,
            };
            const ct0 = fromMs !== undefined ? Math.max(rawSeg.t0, fromMs) : rawSeg.t0;
            const ct1 = toMs !== undefined ? Math.min(rawSeg.t1, toMs) : rawSeg.t1;
            if (ct1 > ct0) {
              hasAnyEligibleValue = true;
              const seg: LinearSegment = {
                laneIdx,
                t0: ct0,
                v0: interpolateSegment(rawSeg, ct0),
                t1: ct1,
                v1: interpolateSegment(rawSeg, ct1),
              };
              let starts = startsByTime.get(ct0);
              if (!starts) {
                starts = [];
                startsByTime.set(ct0, starts);
              }
              starts.push(seg);
              let ends = endsByTime.get(ct1);
              if (!ends) {
                ends = [];
                endsByTime.set(ct1, ends);
              }
              ends.push(seg);
              timeSet.add(ct0);
              timeSet.add(ct1);
            }
          }

          if (!curr.synthetic && inVisibleSpan(curr.atMs) && !leftAttached && !rightAttached) {
            const dupLeft = Boolean(
              prev &&
              curr.atMs === prev.atMs &&
              Math.abs(curr.val - prev.val) < 1e-6 &&
              i > 1 &&
              segOverlapsVisible(run[i - 2].atMs, prev.atMs)
            );
            const dupRight = Boolean(
              next &&
              curr.atMs === next.atMs &&
              Math.abs(curr.val - next.val) < 1e-6 &&
              i + 2 < len &&
              segOverlapsVisible(next.atMs, run[i + 2].atMs)
            );
            if (!dupLeft && !dupRight) hasUncovered = true;
          }
        }
      }
    });

    const times = [...timeSet].sort((a, b) => a - b);

    if (times.length >= 2) {
      const active = new Map<number, LinearSegment>();
      let current: SpreadPoint[] = [];
      let prevLaneIds: number[] = [];
      let prevEndMs: number | null = null;

      const flush = () => {
        if (current.length >= 2) runs.push({ projected, points: current });
        current = [];
        prevLaneIds = [];
        prevEndMs = null;
      };

      const appendPoint = (pt: SpreadPoint) => {
        const len = current.length;
        if (len >= 1) {
          const last = current[len - 1];
          if (
            last.atMs === pt.atMs &&
            Math.abs(last.minPct - pt.minPct) < 1e-6 &&
            Math.abs(last.maxPct - pt.maxPct) < 1e-6
          ) {
            return;
          }
          if (len >= 2) {
            const prev2 = current[len - 2];
            if (pt.atMs > last.atMs && last.atMs > prev2.atMs) {
              const ratio = (last.atMs - prev2.atMs) / (pt.atMs - prev2.atMs);
              const expMin = prev2.minPct + ratio * (pt.minPct - prev2.minPct);
              const expMax = prev2.maxPct + ratio * (pt.maxPct - prev2.maxPct);
              if (Math.abs(last.minPct - expMin) < 1e-5 && Math.abs(last.maxPct - expMax) < 1e-5) {
                current[len - 1] = pt;
                return;
              }
            }
          }
        }
        current.push(pt);
      };

      for (let k = 0; k < times.length - 1; k += 1) {
        const a = times[k];
        const b = times[k + 1];

        const ending = endsByTime.get(a);
        if (ending) {
          for (const seg of ending) {
            if (active.get(seg.laneIdx) === seg) active.delete(seg.laneIdx);
          }
        }
        const starting = startsByTime.get(a);
        if (starting) {
          for (const seg of starting) active.set(seg.laneIdx, seg);
        }

        if (b <= a) continue;

        if (active.size < 2) {
          if (active.size === 1) hasUncovered = true;
          flush();
          continue;
        }

        let continues = false;
        if (prevEndMs === a && prevLaneIds.length > 0) {
          for (let i = 0; i < prevLaneIds.length; i += 1) {
            if (active.has(prevLaneIds[i])) {
              continues = true;
              break;
            }
          }
        }
        if (!continues) flush();

        const activeSegs: LinearSegment[] = [];
        const currLaneIds: number[] = [];
        const startVals: number[] = [];
        const endVals: number[] = [];
        for (const [laneId, seg] of active) {
          currLaneIds.push(laneId);
          activeSegs.push(seg);
          startVals.push(interpolateSegment(seg, a));
          endVals.push(interpolateSegment(seg, b));
        }

        const n = activeSegs.length;
        let minStart = startVals[0];
        let maxStart = startVals[0];
        let minEnd = endVals[0];
        let maxEnd = endVals[0];
        for (let i = 1; i < n; i += 1) {
          if (startVals[i] < minStart) minStart = startVals[i];
          if (startVals[i] > maxStart) maxStart = startVals[i];
          if (endVals[i] < minEnd) minEnd = endVals[i];
          if (endVals[i] > maxEnd) maxEnd = endVals[i];
        }
        appendPoint({ atMs: a, minPct: minStart, maxPct: maxStart });

        const breaks: number[] = [];
        envelopeBreakpoints(startVals, endVals, a, b, true, breaks);
        envelopeBreakpoints(startVals, endVals, a, b, false, breaks);
        if (breaks.length > 0) {
          if (breaks.length > 1) breaks.sort((x, y) => x - y);
          let lastBreak = -Infinity;
          for (let c = 0; c < breaks.length; c += 1) {
            const t = breaks[c];
            if (t - lastBreak <= 1e-6) continue;
            lastBreak = t;
            let minPct = Infinity;
            let maxPct = -Infinity;
            for (let i = 0; i < n; i += 1) {
              const val = interpolateSegment(activeSegs[i], t);
              if (val < minPct) minPct = val;
              if (val > maxPct) maxPct = val;
            }
            appendPoint({ atMs: t, minPct, maxPct });
          }
        }

        appendPoint({ atMs: b, minPct: minEnd, maxPct: maxEnd });

        prevLaneIds = currLaneIds;
        prevEndMs = b;
      }

      flush();
    }
  }

  return { runs, fullyCovered: hasAnyEligibleValue && runs.length > 0 && !hasUncovered };
}

/** Serialize normalized 0–100% spread runs into SVG paths reusing existing chart transforms. */
export function buildSpreadPaths(
  runs: readonly SpreadRun[],
  x: (atMs: number) => number,
  y: (pct: number) => number
): SpreadSvgPaths[] {
  if (!runs.length) return [];
  return runs.map((run) => {
    const upper = run.points
      .map((pt, i) => `${i === 0 ? 'M' : 'L'}${x(pt.atMs)},${y(pt.maxPct)}`)
      .join(' ');
    const lower = run.points
      .map((pt, i) => `${i === 0 ? 'M' : 'L'}${x(pt.atMs)},${y(pt.minPct)}`)
      .join(' ');
    const lowerRev = [...run.points]
      .reverse()
      .map((pt) => `L${x(pt.atMs)},${y(pt.minPct)}`)
      .join(' ');
    return { projected: run.projected, fill: `${upper} ${lowerRev} Z`, upper, lower };
  });
}
