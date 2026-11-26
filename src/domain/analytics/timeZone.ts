/**
 * Time-zone arithmetic shared by prox-usage and ProxUI, on the browser's Intl data only. Days are
 * bucketed by a zone's local midnight; hours stay UTC hours, which are local hours in any zone
 * whose offset is a whole number of hours (the only zones the query contract accepts).
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_FORMATTERS = 64;
const ASCII_ZONE = /^[\x21-\x7e]+$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  // Reject non-ASCII lookalikes (e.g. Kelvin sign K -> k) before case-folding into the cache.
  if (!ASCII_ZONE.test(zone)) throw new RangeError(`Invalid time zone: ${zone}`);
  const key = zone.toLowerCase();
  let format = formatters.get(key);
  if (format) {
    // Refresh recency while keeping the cache bounded.
    formatters.delete(key);
    formatters.set(key, format);
    return format;
  }
  format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  if (formatters.size >= MAX_FORMATTERS) {
    const oldest = formatters.keys().next().value;
    if (oldest !== undefined) formatters.delete(oldest);
  }
  formatters.set(key, format);
  return format;
}

/** Whether the runtime knows this IANA zone. */
export function isKnownTimeZone(zone: string): boolean {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** Canonical IANA spelling for a known zone (e.g. `america/new_york` -> `America/New_York`). */
export function canonicalTimeZone(zone: string): string {
  if (zone.toUpperCase() === 'UTC') return 'UTC';
  return formatter(zone).resolvedOptions().timeZone;
}

function localParts(zone: string, ms: number): Record<string, number> {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(ms))
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return parts;
}

function localDateKey(zone: string, ms: number): number {
  const parts = localParts(zone, ms);
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

/** Minutes east of UTC that `zone` is at the instant `ms`. */
export function zoneOffsetMinutes(zone: string, ms: number): number {
  if (zone === 'UTC') return 0;
  const parts = localParts(zone, ms);
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** Local wall-clock hour (0..23) of `ms` in `zone` (exact for whole-hour zones). */
export function localHour(zone: string, ms: number): number {
  if (zone === 'UTC') return new Date(ms).getUTCHours();
  return new Date(ms + zoneOffsetMinutes(zone, ms) * 60_000).getUTCHours();
}

/** True when the zone's offset is a whole number of hours everywhere in [from, to]. */
export function wholeHourZone(zone: string, from: number, to: number): boolean {
  // Offsets change at most a few times a year; checking every six hours finds any change.
  for (let at = from; at < to + 6 * HOUR; at += 6 * HOUR)
    if (zoneOffsetMinutes(zone, Math.min(at, to)) % 60 !== 0) return false;
  return true;
}

/**
 * The earliest UTC instant of the local calendar date that holds `ms`.
 * On a fall-back at midnight (e.g. America/Havana), both occurrences of 00:00 belong to the
 * same date and share its first instant; on a spring-forward at midnight, the day starts at the
 * first existing local instant (01:00).
 */
export function localDayStart(zone: string, ms: number): number {
  if (zone === 'UTC') return Math.floor(ms / DAY) * DAY;
  const date = localDateKey(zone, ms);
  let start = date - zoneOffsetMinutes(zone, ms) * 60_000;
  start = date - zoneOffsetMinutes(zone, start) * 60_000;
  for (let step = 0; step < 3 && localDateKey(zone, start - 1) === date; step++) {
    start = date - zoneOffsetMinutes(zone, start - 1) * 60_000;
  }
  for (let step = 0; step < 3 && localDateKey(zone, start) < date; step++) {
    start += HOUR;
  }
  return start;
}

/** The local day after the one starting at `dayStart` (23, 24 or 25 hours later). */
export function nextLocalDay(zone: string, dayStart: number): number {
  return localDayStart(zone, dayStart + DAY + 2 * HOUR);
}

/**
 * First instant of a UTC bucket that lies inside `[from, to)`: equals `bucket` for unclipped
 * buckets, and `from` for a clipped first bucket so local offsets/labels stay inside the range.
 */
export function inRangeBucketTime(bucket: number, from: number): number {
  return Math.max(bucket, from);
}
