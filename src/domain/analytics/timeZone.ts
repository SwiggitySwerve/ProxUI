/**
 * Time-zone arithmetic shared by prox-usage and ProxUI, on the browser's Intl data only. Days are
 * bucketed by a zone's local midnight; hours stay UTC hours, which are local hours in any zone
 * whose offset is a whole number of hours (the only zones the query contract accepts).
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let format = formatters.get(zone);
  if (!format) {
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
    formatters.set(zone, format);
  }
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

/** Minutes east of UTC that `zone` is at the instant `ms`. */
export function zoneOffsetMinutes(zone: string, ms: number): number {
  if (zone === 'UTC') return 0;
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(ms))
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
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

/** True when the zone's offset is a whole number of hours everywhere in [from, to]. */
export function wholeHourZone(zone: string, from: number, to: number): boolean {
  // Offsets change at most a few times a year; checking every six hours finds any change.
  for (let at = from; at < to + 6 * HOUR; at += 6 * HOUR)
    if (zoneOffsetMinutes(zone, Math.min(at, to)) % 60 !== 0) return false;
  return true;
}

/** The UTC instant of local midnight starting the local day that holds `ms`. */
export function localDayStart(zone: string, ms: number): number {
  if (zone === 'UTC') return Math.floor(ms / DAY) * DAY;
  const offset = zoneOffsetMinutes(zone, ms) * 60_000;
  const midnight = Math.floor((ms + offset) / DAY) * DAY;
  // Midnight may sit on the other side of a daylight-saving change, with its own offset.
  return midnight - zoneOffsetMinutes(zone, midnight - offset) * 60_000;
}

/** The local day after the one starting at `dayStart` (23, 24 or 25 hours later). */
export function nextLocalDay(zone: string, dayStart: number): number {
  return localDayStart(zone, dayStart + DAY + 2 * HOUR);
}
