import { beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../src/i18n';
import {
  canonicalTimeZone,
  isKnownTimeZone,
  localDayStart,
  nextLocalDay,
  wholeHourZone,
  zoneOffsetMinutes,
} from '../src/domain/analytics/timeZone';
import { preferredZone, zoneName } from '../src/features/analytics/displayZone';
import { bucketQuery, rangeQuery } from '../src/features/analytics/queryState';
import { bucketTimeline, hourGrid, timeTicks } from '../src/features/analytics/chartGeometry';
import { AnalyticsViews } from '../src/features/analytics/AnalyticsViews';
import { HourHeatmap } from '../src/features/analytics/HourHeatmap';
import { ProviderStackChart } from '../src/features/analytics/ProviderStackChart';
import { RequestTable } from '../src/features/analytics/RequestTable';
import { TrendChart } from '../src/features/analytics/TrendChart';
import { validateAnalyticsQuery } from '../server/usage/validate';
import { analyticsUiResponse } from './fixtures/analyticsUi';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NY = 'America/New_York';
const HAVANA = 'America/Havana';
const LORD_HOWE = 'Australia/Lord_Howe';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

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

  test('repeated midnight (America/Havana Nov 1) shares one day boundary and Yesterday stays Oct 31', () => {
    // Havana falls back 01:00 CDT -> 00:00 CST on Nov 1, 2026:
    // 04:00Z = first 00:00 CDT, 05:00Z = second 00:00 CST. Both belong to Nov 1 (boundary 04:00Z).
    const firstMidnight = Date.UTC(2026, 10, 1, 4, 0);
    const secondMidnight = Date.UTC(2026, 10, 1, 5, 0);
    expect(localDayStart(HAVANA, firstMidnight)).toBe(firstMidnight);
    expect(localDayStart(HAVANA, firstMidnight + 30 * 60_000)).toBe(firstMidnight);
    expect(localDayStart(HAVANA, secondMidnight)).toBe(firstMidnight);
    expect(localDayStart(HAVANA, secondMidnight + 30 * 60_000)).toBe(firstMidnight);
    expect(nextLocalDay(HAVANA, firstMidnight) - firstMidnight).toBe(25 * HOUR);
    // After the second midnight, Yesterday must still be Oct 31 (04:00Z Oct 31 to 04:00Z Nov 1).
    expect(rangeQuery('yesterday', secondMidnight + 15 * 60_000, 'auto', HAVANA)).toMatchObject({
      from_ms: Date.UTC(2026, 9, 31, 4, 0),
      to_ms: firstMidnight,
      time_zone: HAVANA,
    });
    // Spring-forward at midnight (Mar 8, 2026): 00:00 is skipped; day starts at 05:00Z (01:00 CDT).
    const havanaSpring = Date.UTC(2026, 2, 8, 5, 0);
    expect(localDayStart(HAVANA, havanaSpring)).toBe(havanaSpring);
    expect(localDayStart(HAVANA, Date.UTC(2026, 2, 8, 12, 0))).toBe(havanaSpring);
    expect(nextLocalDay(HAVANA, havanaSpring) - havanaSpring).toBe(23 * HOUR);
  });

  test('only whole-hour ranges use the local zone; part-hour ranges fall back to UTC and rebuild bounds', () => {
    const now = Date.UTC(2026, 10, 26);
    expect(wholeHourZone('Asia/Kolkata', now - DAY, now)).toBe(false);
    expect(preferredZone(false, NY)).toBe(NY);
    expect(preferredZone(true, NY)).toBe('UTC');
    expect(rangeQuery('24h', now, 'auto', 'Asia/Kolkata').time_zone).toBe('UTC');
    expect(rangeQuery('24h', now, 'auto', NY).time_zone).toBe(NY);
    expect(zoneName(NY, Date.UTC(2026, 0, 15), 'en-US')).toBe('EST');
    expect(zoneName('UTC', 0, 'en-US')).toBe('UTC');

    // Australia/Lord_Howe switches from UTC+10:30 to UTC+11:00 on Oct 4, 2026.
    // On Oct 5, 2026 12:00Z, the last hour is entirely UTC+11 (whole-hour -> accepted),
    // while 7d includes Oct 3 (UTC+10:30 -> falls back to UTC).
    const lordHoweOct5 = Date.UTC(2026, 9, 5, 12, 0);
    expect(rangeQuery('1h', lordHoweOct5, 'auto', LORD_HOWE).time_zone).toBe(LORD_HOWE);
    expect(rangeQuery('7d', lordHoweOct5, 'auto', LORD_HOWE).time_zone).toBe('UTC');
    // Asia/Kolkata Today falls back to UTC and rebuilds midnight at UTC 00:00 (not IST midnight).
    const kolkataNow = Date.UTC(2026, 10, 26, 10, 0);
    expect(rangeQuery('today', kolkataNow, 'auto', 'Asia/Kolkata')).toMatchObject({
      from_ms: Date.UTC(2026, 10, 26, 0, 0),
      to_ms: kolkataNow,
      time_zone: 'UTC',
    });
  });

  test('case-variant zone spellings canonicalize cleanly and non-ASCII lookalikes are rejected even on a warm cache', () => {
    expect(canonicalTimeZone('america/new_york')).toBe(NY);
    expect(canonicalTimeZone('utc')).toBe('UTC');
    const now = Date.UTC(2026, 10, 26, 12, 0);
    const validated = validateAnalyticsQuery({
      from_ms: now - HOUR,
      to_ms: now,
      time_zone: 'AMERICA/new_york',
      granularity: 'hour',
      outcome: 'all',
    });
    expect(validated.time_zone).toBe(NY);
    // Warm Asia/Tokyo, then ensure Kelvin sign (U+212A, lowercases to 'k') is still rejected.
    expect(isKnownTimeZone('Asia/Tokyo')).toBe(true);
    expect(isKnownTimeZone('Asia/To\u212Ayo')).toBe(false);
    expect(() =>
      validateAnalyticsQuery({
        from_ms: now - HOUR,
        to_ms: now,
        time_zone: 'Asia/To\u212Ayo',
        granularity: 'hour',
        outcome: 'all',
      })
    ).toThrow();
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
    const days = bucketTimeline([], from, to, DAY, NY).map((b) => b.at);
    expect(days).toEqual([1, 2, 3, 4].map((day) => Date.UTC(2026, 0, day, 5)));
    expect(timeTicks(from, to, DAY, 6, NY)).toEqual(
      [2, 3, 4].map((day) => Date.UTC(2026, 0, day, 5))
    );
    expect(hourGrid(new Map(), from, to, NY).map((row) => row.day)).toEqual(days);
  });

  test('hour ticks sit on the local clock: every six hours at 00, 06, 12, 18 New York time', () => {
    const from = Date.UTC(2026, 0, 2, 0);
    const ticks = timeTicks(from, from + DAY, HOUR, 4, NY);
    expect(ticks.map((at) => (new Date(at).getUTCHours() + 24 - 5) % 24)).toEqual([0, 6, 12, 18]);
  });

  test('a day drilldown on a daylight-saving day covers its 23 hours', () => {
    const day = Date.UTC(2026, 2, 8, 5);
    const query = { ...rangeQuery('7d', Date.UTC(2026, 2, 12), 'day', NY) };
    const drilled = bucketQuery(query, day);
    expect(drilled.to_ms - drilled.from_ms).toBe(23 * HOUR);
  });

  test('date heatmap places spring-forward and fall-back hours on their true wall-clock columns', () => {
    // Spring-forward Mar 8, 2026 in NY: 02:00 is skipped; 03:00 is 07:00Z; 23:00 is Mar 9 03:00Z.
    const springStart = Date.UTC(2026, 2, 8, 5);
    const springEnd = Date.UTC(2026, 2, 9, 4);
    const springMap = new Map<number, number | null>([
      [Date.UTC(2026, 2, 8, 7), 11], // 03:00 EDT
      [Date.UTC(2026, 2, 9, 3), 23], // 23:00 EDT
    ]);
    const springRows = hourGrid(springMap, springStart, springEnd, NY);
    expect(springRows).toHaveLength(1);
    expect(springRows[0].cells[2]).toEqual({ at: null, value: null, state: 'skipped' });
    expect(springRows[0].cells[3]).toEqual({
      at: Date.UTC(2026, 2, 8, 7),
      value: 11,
      state: 'value',
    });
    expect(springRows[0].cells[23]).toEqual({
      at: Date.UTC(2026, 2, 9, 3),
      value: 23,
      state: 'value',
    });

    // Fall-back Nov 1, 2026 in NY: 01:00 repeats (05:00Z EDT and 06:00Z EST); 23:00 EST is Nov 2 04:00Z.
    const fallStart = Date.UTC(2026, 10, 1, 4);
    const fallEnd = Date.UTC(2026, 10, 2, 5);
    const firstOne = Date.UTC(2026, 10, 1, 5); // 01:00 EDT
    const secondOne = Date.UTC(2026, 10, 1, 6); // 01:00 EST
    const twoAm = Date.UTC(2026, 10, 1, 7); // 02:00 EST
    const elevenPm = Date.UTC(2026, 10, 2, 4); // 23:00 EST
    const fallMap = new Map<number, number | null>([
      [firstOne, 10],
      [secondOne, 4],
      [twoAm, 2],
      [elevenPm, 9],
    ]);
    const fallRows = hourGrid(fallMap, fallStart, fallEnd, NY);
    expect(fallRows).toHaveLength(1);
    expect(fallRows[0].cells[1]).toEqual({
      at: firstOne,
      value: 10,
      state: 'value',
      repeat: { at: secondOne, value: 4, state: 'value' },
    });
    expect(fallRows[0].cells[2]).toEqual({ at: twoAm, value: 2, state: 'value' });
    expect(fallRows[0].cells[23]).toEqual({ at: elevenPm, value: 9, state: 'value' });

    // Rendered heatmap exposes BOTH fall-back occurrences as separate drillable buttons and marks skipped hours.
    const fallHtml = renderToStaticMarkup(
      createElement(HourHeatmap, {
        title: 'Events by hour · America/New_York',
        points: fallMap,
        from: fallStart,
        to: fallEnd,
        hourly: true,
        zone: NY,
        onSelect: () => {},
        onShowHourly: () => {},
      })
    );
    expect(fallHtml).toContain(`data-at="${firstOne}"`);
    expect(fallHtml).toContain(`data-at="${secondOne}"`);
    expect(fallHtml).toContain('01:00 EDT: 10 events');
    expect(fallHtml).toContain('01:00 EST: 4 events');
    expect(fallHtml).toContain('10 (EDT) / 4 (EST)');

    const springHtml = renderToStaticMarkup(
      createElement(HourHeatmap, {
        title: 'Events by hour · America/New_York',
        points: springMap,
        from: springStart,
        to: springEnd,
        hourly: true,
        zone: NY,
        onSelect: () => {},
        onShowHourly: () => {},
      })
    );
    expect(springHtml).toContain('data-state="skipped"');
    expect(springHtml).toContain('<td>skipped (DST)</td>');
  });

  test('Requests table uses a stable zone column header and per-row abbreviations across DST fall-back', () => {
    const first = Date.UTC(2026, 10, 1, 5, 30); // 01:30 EDT
    const second = Date.UTC(2026, 10, 1, 6, 30); // 01:30 EST
    const item = (id: string, ts: number) => ({
      id,
      timestamp_ms: ts,
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      failed: false,
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 15,
      latency_ms: 100,
      ttft_ms: 20,
      cost: { usd: 0.01, status: 'estimated' as const, reasons: [] },
    });
    const html = renderToStaticMarkup(
      createElement(RequestTable, {
        data: {
          items: [item('r1', first), item('r2', second)],
          total_count: 2,
          has_more: false,
          next_before_ms: null,
          next_before_id: null,
        },
        selected: null,
        onSelect: () => {},
        onPrevious: () => {},
        onNext: () => {},
        canPrevious: false,
        canNext: false,
        page: 1,
        zone: NY,
      })
    );
    expect(html).toContain('Time · America/New_York');
    expect(html).toContain('01:30 EDT');
    expect(html).toContain('01:30 EST');
  });

  test('Lord Howe date heatmap keeps UTC :00 bucket keys even when local midnight sits on :30', () => {
    // Oct 4, 2026 in Australia/Lord_Howe: springs forward +10:30 -> +11:00 at Oct 3 15:30Z.
    // Its local midnight is Oct 3 13:30Z, while the 24h range [Oct 3 16:00Z, Oct 4 16:00Z] is all +11:00.
    const from = Date.UTC(2026, 9, 3, 16, 0);
    const to = Date.UTC(2026, 9, 4, 16, 0);
    const bucketThreeAm = Date.UTC(2026, 9, 3, 16, 0); // Oct 4 03:00 GMT+11
    const bucketNextDay = Date.UTC(2026, 9, 4, 13, 0); // Oct 5 00:00 GMT+11
    const rows = hourGrid(
      new Map([
        [bucketThreeAm, 12],
        [bucketNextDay, 7],
      ]),
      from,
      to,
      LORD_HOWE
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].cells[2].state).toBe('outside');
    expect(rows[0].cells[3]).toEqual({ at: bucketThreeAm, value: 12, state: 'value' });
    expect(rows[1].cells[0]).toEqual({ at: bucketNextDay, value: 7, state: 'value' });

    // Clipped first bucket [Oct 3 15:45Z, Oct 4 15:45Z]: UTC bucket 15:00Z holds events at 15:45..16:00Z
    // (Oct 4 02:45 GMT+11), so it sits in column 02 with key 15:00Z and labels in GMT+11 (not GMT+10:30).
    const clippedFrom = Date.UTC(2026, 9, 3, 15, 45);
    const clippedTo = clippedFrom + DAY;
    const clippedBucket = Date.UTC(2026, 9, 3, 15, 0);
    const clippedRows = hourGrid(new Map([[clippedBucket, 5]]), clippedFrom, clippedTo, LORD_HOWE);
    expect(clippedRows[0].cells[2]).toEqual({ at: clippedBucket, value: 5, state: 'value' });
    expect(clippedRows[0].cells[1].state).toBe('outside');
    const clippedHtml = renderToStaticMarkup(
      createElement(HourHeatmap, {
        title: 'Events by hour · GMT+11',
        points: new Map([[clippedBucket, 5]]),
        from: clippedFrom,
        to: clippedTo,
        hourly: true,
        zone: LORD_HOWE,
        onSelect: () => {},
        onShowHourly: () => {},
      })
    );
    expect(clippedHtml).toContain(`data-at="${clippedBucket}"`);
    expect(clippedHtml).toContain('02:45');
    expect(clippedHtml).toContain('GMT+11');
    expect(clippedHtml).not.toContain('GMT+10:30');

    const stackHtml = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ProviderStackChart, {
          title: 'Tokens by provider',
          split: [
            {
              provider: 'claude',
              bucket_ms: clippedBucket,
              calls: 1,
              failure_calls: 0,
              input_tokens: 100,
              output_tokens: 50,
              cache_read_tokens: 0,
              cache_creation_tokens: 0,
              reasoning_tokens: 0,
              total_tokens: 150,
            },
          ],
          buckets: [
            { at: clippedBucket, measured: true },
            { at: clippedBucket + HOUR, measured: true },
          ],
          interval: HOUR,
          from: clippedFrom,
          zone: LORD_HOWE,
          label: (provider) => provider,
        })
      )
    );
    expect(stackHtml).toContain(`data-at="${clippedBucket}"`);
    expect(stackHtml).toContain('>02:45</span>');
    expect(stackHtml).not.toContain('01:30');
  });

  test('Performance omits peak timestamp when an older account payload lacks peak_at_ms', () => {
    const legacyAccount = {
      instance: 'claude-primary',
      auth_index: 'auth-1',
      label: 'legacy@example.test',
      providers: ['claude'],
      calls: 10,
      failure_calls: 0,
      total_tokens: 1000,
      peak_in_flight: 4,
      peak_at_ms: undefined as unknown as null,
    };
    const html = renderToStaticMarkup(
      createElement(AnalyticsViews, {
        tab: 'performance',
        data: { ...analyticsUiResponse, accounts: [legacyAccount] },
        onBucket: () => {},
        onModel: () => {},
        onProvider: () => {},
        onShowHourly: () => {},
        zone: 'UTC',
      })
    );
    const peakSection = html.slice(html.indexOf('Peak requests in flight, by account'));
    expect(peakSection).toContain('claude-primary');
    expect(peakSection).toContain('<td>Unavailable</td>');
    // Must not format Date.now() as a UTC timestamp in the peak section.
    expect(peakSection).not.toContain(' UTC');
  });

  test('TrendChart keeps local midnight visible on narrow screens and keeps hourly ticks on-grid across DST', () => {
    // Nov 1, 2026 in NY crosses fall-back (01:00 EDT -> 01:00 EST).
    // 24h from Oct 31 12:00 EDT (16:00Z) to Nov 1 12:00 EST (17:00Z):
    // local 6h ticks must land on 12:00 EDT, 18:00 EDT, 00:00 EDT, 06:00 EST, 12:00 EST (never 11:00 EST).
    const from = Date.UTC(2026, 9, 31, 16, 0);
    const to = Date.UTC(2026, 10, 1, 17, 0);
    const ticks = timeTicks(from, to, HOUR, 6, NY);
    const localHours = ticks.map((at) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: NY,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(at)
    );
    expect(localHours).toEqual(['12', '18', '00', '06', '12']);
    // Local midnight (Nov 1 00:00 EDT = 04:00Z) must NOT be marked data-minor="true" on narrow screens.
    const html = renderToStaticMarkup(
      createElement(TrendChart, {
        title: 'Usage',
        series: [{ key: 'calls', label: 'Events', color: 'white' }],
        points: [{ at: from, values: [5] }],
        from,
        to,
        interval: HOUR,
        zone: NY,
      })
    );
    expect(html).toContain('data-minor="false">Nov 1</span>');
  });

  test('HourHeatmap scale includes zero, unmeasured, and DST skipped keys when applicable', () => {
    const springStart = Date.UTC(2026, 2, 8, 5);
    const springEnd = Date.UTC(2026, 2, 9, 4);
    const html = renderToStaticMarkup(
      createElement(HourHeatmap, {
        title: 'Events by hour · America/New_York',
        points: new Map([[Date.UTC(2026, 2, 8, 7), 11]]),
        from: springStart,
        to: springEnd,
        hourly: true,
        zone: NY,
        onSelect: () => {},
        onShowHourly: () => {},
      })
    );
    expect(html).toContain('data-level="0"');
    expect(html).toContain('not measured</span>');
    expect(html).toContain('skipped (DST)</span>');
  });
});
