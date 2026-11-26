import {
  localDayStart,
  localHour,
  nextLocalDay,
  zoneOffsetMinutes,
} from '@/domain/analytics/timeZone';
export interface ChartDatum {
  key: string;
  label: string;
  value: number | null;
  /** Failed events within `value`, as prox-usage counted them. */
  failed?: number;
  /** The provider whose colour this row takes; none keeps the neutral bar. */
  provider?: string;
  /** Optional secondary fact shown beside the value and in the data table (e.g. peak timestamp). */
  detail?: string;
  at?: number;
}
export interface LinePoint {
  at: number;
  value: number | null;
}
/**
 * Polyline segments for one timeline series scaled to its own maximum. A null value or a
 * missing bucket ends the segment, so the line never bridges an unmeasured period.
 */
export function lineSegments(
  points: LinePoint[],
  frame: {
    from: number;
    to: number;
    interval: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
  },
  shared?: number
) {
  const maximum = shared ?? Math.max(0, ...points.map((p) => p.value ?? 0));
  const span = Math.max(1, frame.to - frame.from);
  // A bucket sits at the middle of its part inside the range, so partial edge buckets stay on the plot.
  const x = (at: number) => {
    const start = Math.max(frame.from, at);
    const end = Math.min(frame.to, at + frame.interval);
    const mid = end > start ? (start + end) / 2 : Math.min(Math.max(at, frame.from), frame.to);
    return frame.left + ((mid - frame.from) / span) * (frame.right - frame.left);
  };
  const y = (value: number) =>
    frame.bottom - (maximum > 0 ? value / maximum : 0) * (frame.bottom - frame.top);
  const segments: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  let previous: number | null = null;
  for (const point of [...points].sort((a, b) => a.at - b.at)) {
    const gap = previous !== null && point.at - previous > frame.interval * 1.5;
    if (point.value === null || gap) {
      if (current.length) segments.push(current);
      current = [];
    }
    if (point.value !== null) current.push([x(point.at), y(point.value)]);
    previous = point.at;
  }
  if (current.length) segments.push(current);
  return { maximum, segments, x, y };
}

/** Axis maximum on a 1-1.5-2-2.5-3-4-5 step: round quarter ticks with little headroom. */
export function niceMaximum(value: number) {
  if (!(value > 0)) return 0;
  // 5% headroom, so peaks never sit on the top gridline.
  const raw = (value * 1.05) / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 10].map((m) => m * power).find((s) => s >= raw - 1e-9)!;
  return step * 4;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
/**
 * Evenly spaced tick times on whole hours or days of the page's zone, at most `maxTicks` of them.
 * Hours align to the zone's clock (its offset is a whole number of hours); days start at its
 * local midnight.
 */
export function timeTicks(
  from: number,
  to: number,
  interval: number,
  maxTicks: number,
  zone = 'UTC'
) {
  const steps = [1, 2, 3, 4, 6, 12]
    .map((h) => h * HOUR)
    .concat([1, 2, 5, 7, 14].map((d) => d * DAY));
  const step =
    steps.find((s) => s >= interval && (to - from) / s <= maxTicks) ?? steps[steps.length - 1];
  const ticks: number[] = [];
  if (step < DAY) {
    const offset = zoneOffsetMinutes(zone, from) * 60_000;
    for (let at = Math.ceil((from + offset) / step) * step - offset; at <= to; at += step)
      ticks.push(at);
    return ticks;
  }
  let day = localDayStart(zone, from);
  if (day < from) day = nextLocalDay(zone, day);
  for (let index = 0; day <= to; day = nextLocalDay(zone, day), index++)
    if (index % (step / DAY) === 0) ticks.push(day);
  return ticks;
}

/**
 * Every UTC bucket in the range, marking which ones the server returned. The service only returns
 * buckets that hold events, so an absent bucket in fully retained data had no traffic.
 */
export function bucketTimeline(
  present: number[],
  from: number,
  to: number,
  interval: number,
  zone = 'UTC'
) {
  const seen = new Set(present);
  const buckets: { at: number; present: boolean }[] = [];
  // Days start at the zone's local midnight, as prox-usage buckets them (23 to 25 hours long).
  const next = (at: number) => (interval >= DAY ? nextLocalDay(zone, at) : at + interval);
  const first =
    interval >= DAY ? localDayStart(zone, from) : Math.floor(from / interval) * interval;
  for (let at = first; at < to; at = next(at)) buckets.push({ at, present: seen.has(at) });
  return buckets;
}

const round = (n: number) => Math.round(n * 100) / 100;
/**
 * A monotone cubic path through the points (Fritsch–Carlson tangents): smooth, but never
 * overshooting between readings, so flat runs stay flat and zero never dips below the axis.
 */
export function smoothPath(points: Array<[number, number]>) {
  const [first] = points;
  if (!first) return '';
  let path = `M${round(first[0])},${round(first[1])}`;
  if (points.length < 3) {
    for (const [x, y] of points.slice(1)) path += ` L${round(x)},${round(y)}`;
    return path;
  }
  const n = points.length;
  const dx = points.slice(1).map(([x], i) => x - points[i][0]);
  const slope = points.slice(1).map(([, y], i) => (y - points[i][1]) / (dx[i] || 1));
  const tangent = points.map((_, i) => {
    if (i === 0) return slope[0];
    if (i === n - 1) return slope[n - 2];
    const [a, b] = [slope[i - 1], slope[i]];
    if (a * b <= 0) return 0;
    return (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / a + (dx[i] + 2 * dx[i - 1]) / b);
  });
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const third = dx[i] / 3;
    path += ` C${round(x0 + third)},${round(y0 + tangent[i] * third)} ${round(x1 - third)},${round(
      y1 - tangent[i + 1] * third
    )} ${round(x1)},${round(y1)}`;
  }
  return path;
}

export type HourCellState = 'value' | 'gap' | 'outside' | 'skipped';
export interface HourOccurrence {
  at: number;
  value: number | null;
  state: 'value' | 'gap';
}
export interface HourCell {
  /** Primary UTC bucket start for this wall-clock hour, or null when skipped by DST. */
  at: number | null;
  value: number | null;
  state: HourCellState;
  /** Second UTC hour sharing this clock hour on a fall-back day (e.g. 01:00 EST after 01:00 EDT). */
  repeat?: HourOccurrence;
}
/**
 * Hourly values as one row per local day and 24 columns for local wall-clock hours 00..23.
 * Hours outside `[from, to)` are `outside`; in-window hours with no value are `gap`; clock
 * hours skipped by spring-forward are `skipped`; repeated fall-back clock hours carry their
 * second UTC occurrence in `repeat` so both remain visible and drillable.
 */
export function hourGrid(
  values: ReadonlyMap<number, number | null>,
  from: number,
  to: number,
  zone = 'UTC'
): { day: number; cells: HourCell[] }[] {
  if (to <= from) return [];
  const days: { day: number; nextDay: number; byHour: HourOccurrence[][] }[] = [];
  const rowByDay = new Map<number, (typeof days)[number]>();
  for (let day = localDayStart(zone, from); day < to; day = nextLocalDay(zone, day)) {
    const row = {
      day,
      nextDay: nextLocalDay(zone, day),
      byHour: Array.from({ length: 24 }, () => [] as HourOccurrence[]),
    };
    days.push(row);
    rowByDay.set(day, row);
  }
  // Iterate UTC whole-hour bucket starts (matching server timeline keys and drilldown intervals).
  // A clipped first bucket uses its first instant inside [from, to) for local day/hour placement.
  const firstBucket = Math.floor(from / HOUR) * HOUR;
  for (let at = firstBucket; at < to; at += HOUR) {
    const sample = Math.max(at, from);
    const row = rowByDay.get(localDayStart(zone, sample));
    if (!row) continue;
    const hour = localHour(zone, sample);
    const value = values.get(at) ?? null;
    const state: HourOccurrence['state'] = value === null ? 'gap' : 'value';
    row.byHour[hour].push({ at, value, state });
  }
  return days.map(({ day, nextDay, byHour }) => {
    const cells: HourCell[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const list = byHour[hour];
      if (list.length === 0) {
        const hasPrev = byHour.slice(0, hour).some((bucket) => bucket.length > 0);
        const hasNext = byHour.slice(hour + 1).some((bucket) => bucket.length > 0);
        const skippedStart =
          !hasPrev && hasNext && day >= from && day < to && localHour(zone, day) > hour;
        const skippedEnd =
          hasPrev &&
          !hasNext &&
          nextDay > from &&
          nextDay <= to &&
          localHour(zone, nextDay - 1) < hour;
        const skipped = (hasPrev && hasNext) || skippedStart || skippedEnd;
        cells.push({ at: null, value: null, state: skipped ? 'skipped' : 'outside' });
      } else if (list.length === 1) {
        const [first] = list;
        cells.push({ at: first.at, value: first.value, state: first.state });
      } else {
        const [first, second] = list;
        cells.push({ at: first.at, value: first.value, state: first.state, repeat: second });
      }
    }
    return { day, cells };
  });
}
/** Four shades above zero, so a cell reads as a band rather than an exact amount. */
export function heatLevel(value: number | null, maximum: number): 0 | 1 | 2 | 3 | 4 {
  if (!value || value <= 0 || maximum <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / maximum) * 4))) as 1 | 2 | 3 | 4;
}
