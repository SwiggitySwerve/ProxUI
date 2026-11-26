import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { canonicalTimeZone, isKnownTimeZone } from '@/domain/analytics/timeZone';

/**
 * Local time or UTC for every date and hour Analytics shows: one choice per browser, local by
 * default. prox-usage buckets days at the zone's local midnight.
 */
interface DisplayZoneState {
  utc: boolean;
  setUtc: (utc: boolean) => void;
}

export const useDisplayZoneStore = create<DisplayZoneState>()(
  persist(
    (set) => ({
      utc: false,
      setUtc: (utc) => set({ utc }),
    }),
    {
      name: 'proxui-display-zone',
      merge: (persisted, current) => ({
        ...current,
        utc: (persisted as Partial<DisplayZoneState> | undefined)?.utc === true,
      }),
    }
  )
);

/** The browser's own zone, as an IANA name. */
export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The zone the user prefers before checking whether a specific range has a part-hour offset. */
export function preferredZone(utc: boolean, local = browserZone()): string {
  if (utc || local === 'UTC') return 'UTC';
  return isKnownTimeZone(local) ? canonicalTimeZone(local) : 'UTC';
}

/** A short name for the zone at an instant: "UTC", "EST", "GMT+2". */
export function zoneName(zone: string, at: number, locale: string): string {
  if (zone === 'UTC') return 'UTC';
  return (
    new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? zone
  );
}

/** Short zone abbreviation when constant across [from, to], else the stable IANA zone name. */
export function rangeZoneLabel(zone: string, from: number, to: number, locale: string): string {
  if (zone === 'UTC') return 'UTC';
  const start = zoneName(zone, from, locale);
  const end = zoneName(zone, to, locale);
  return start === end ? end : zone;
}
