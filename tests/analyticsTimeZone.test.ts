import { describe, expect, test } from 'bun:test';
import {
  localDayStart,
  nextLocalDay,
  wholeHourZone,
  zoneOffsetMinutes,
} from '../src/domain/analytics/timeZone';
import { analyticsZone, zoneName } from '../src/features/analytics/displayZone';
import { bucketQuery, rangeQuery } from '../src/features/analytics/queryState';
import { bucketTimeline, hourGrid, timeTicks } from '../src/features/analytics/chartGeometry';

const HOUR = 3_600_000;
const NY = 'America/New_York';

describe('zone arithmetic', () => {
  test('offsets follow daylight saving', () => {
    expect(zoneOffsetMinutes(NY, Date.UTC(2026, 0, 15))).toBe(-300);
    expect(zoneOffsetMinutes(NY, Date.UTC(2026, 6, 15))).toBe(-240);
    expect(zoneOffsetMinutes('UTC', Date.UTC(2026, 6, 15))).toBe(0);
  });

  test('a local day starts at local midnight, and a spring-forward day is 23 hours', () => {
    // 03:00 UTC on 2 January is 22:00 on 1 January in New York.
    expect(localDayStart(NY, Date.UTC(2026, 0, 2, 3))).toBe(Date.UTC(2026, 0, 1, 5));
    const springForward = localDayStart(NY, Date.UTC(2026, 2, 8, 12));
    expect(springForward).toBe(Date.UTC(2026, 2, 8, 5));
    expect(nextLocalDay(NY, springForward) - springForward).toBe(23 * HOUR);
  });

  test('only whole-hour zones are used; a part-hour zone falls back to UTC', () => {
    const now = Date.UTC(2026, 10, 26);
    expect(wholeHourZone('Asia/Kolkata', now - 86_400_000, now)).toBe(false);
    expect(analyticsZone(false, 'Asia/Kolkata', now)).toBe('UTC');
    expect(analyticsZone(false, NY, now)).toBe(NY);
    expect(analyticsZone(true, NY, now)).toBe('UTC');
    expect(zoneName(NY, Date.UTC(2026, 0, 15), 'en-US')).toBe('EST');
    expect(zoneName('UTC', 0, 'en-US')).toBe('UTC');
  });
});

describe('the page in a local zone', () => {
  const now = Date.UTC(2026, 0, 2, 15, 30); // 10:30 in New York
  test('Today and Yesterday are local calendar days, and the query names the zone', () => {
    expect(rangeQuery('today', now, 'auto', NY)).toMatchObject({
      from_ms: Date.UTC(2026, 0, 2, 5),
      to_ms: now,
      time_zone: NY,
    });
    expect(rangeQuery('yesterday', now, 'auto', NY)).toMatchObject({
      from_ms: Date.UTC(2026, 0, 1, 5),
      to_ms: Date.UTC(2026, 0, 2, 5),
    });
  });

  test('day buckets, day ticks and hour-map rows start at local midnight', () => {
    const from = Date.UTC(2026, 0, 1, 12);
    const to = Date.UTC(2026, 0, 4, 12);
    const days = bucketTimeline([], from, to, 86_400_000, NY).map((b) => b.at);
    expect(days).toEqual([1, 2, 3, 4].map((day) => Date.UTC(2026, 0, day, 5)));
    expect(timeTicks(from, to, 86_400_000, 6, NY)).toEqual(
      [2, 3, 4].map((day) => Date.UTC(2026, 0, day, 5))
    );
    expect(hourGrid(new Map(), from, to, NY).map((row) => row.day)).toEqual(days);
  });

  test('hour ticks sit on the local clock: every six hours at 00, 06, 12, 18 New York time', () => {
    const from = Date.UTC(2026, 0, 2, 0);
    const ticks = timeTicks(from, from + 24 * HOUR, HOUR, 4, NY);
    expect(ticks.map((at) => (new Date(at).getUTCHours() + 24 - 5) % 24)).toEqual([0, 6, 12, 18]);
  });

  test('a day drilldown on a daylight-saving day covers its 23 hours', () => {
    const day = Date.UTC(2026, 2, 8, 5);
    const query = { ...rangeQuery('7d', Date.UTC(2026, 2, 12), 'day', NY) };
    const drilled = bucketQuery(query, day);
    expect(drilled.to_ms - drilled.from_ms).toBe(23 * HOUR);
  });
});
