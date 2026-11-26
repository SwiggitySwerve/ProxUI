import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isKnownTimeZone, wholeHourZone } from '@/domain/analytics/timeZone';

const DAY = 86_400_000;

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

/**
 * The zone Analytics asks for and labels with: UTC when chosen, else the browser's zone, unless
 * its offset is not a whole number of hours (hours could not then be exact), when it is UTC too.
 */
export function analyticsZone(utc: boolean, local = browserZone(), now = Date.now()): string {
  if (utc || local === 'UTC') return 'UTC';
  return isKnownTimeZone(local) && wholeHourZone(local, now - 32 * DAY, now + DAY) ? local : 'UTC';
}

/** The zone the page uses now, following the browser's choice. */
export function useAnalyticsZone(): string {
  const utc = useDisplayZoneStore((state) => state.utc);
  return analyticsZone(utc);
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
