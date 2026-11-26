import { beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { heatLevel, hourGrid } from '../src/features/analytics/chartGeometry';
import { HourHeatmap } from '../src/features/analytics/HourHeatmap';
import { rangeQuery, servedBucketQuery } from '../src/features/analytics/queryState';
import { AnalyticsViews } from '../src/features/analytics/AnalyticsViews';
import { analyticsScenario } from './fixtures/analyticsUi';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const noop = () => {};
beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('hour grid', () => {
  // 2 Jan 2026 10:30 UTC to 3 Jan 2026 10:30 UTC: two partial days.
  const from = Date.UTC(2026, 0, 2, 10, 30);
  const to = from + DAY;
  const day = Date.UTC(2026, 0, 2);

  test('one row per UTC day; hours outside the window are outside, the cut hours are inside', () => {
    const rows = hourGrid(new Map(), from, to);
    expect(rows.map((row) => row.day)).toEqual([day, day + DAY]);
    expect(rows[0].cells[9].state).toBe('outside');
    // 10:00 holds 10:30, so it is in the window.
    expect(rows[0].cells[10].state).toBe('gap');
    expect(rows[1].cells[10].state).toBe('gap');
    expect(rows[1].cells[11].state).toBe('outside');
  });

  test('a supplied zero is a quiet hour; an absent hour is unmeasured', () => {
    const cells = hourGrid(
      new Map([
        [day + 12 * HOUR, 7],
        [day + 13 * HOUR, 0],
      ]),
      from,
      to
    )[0].cells;
    expect(cells[12]).toEqual({ at: day + 12 * HOUR, value: 7, state: 'value' });
    expect(cells[13]).toMatchObject({ value: 0, state: 'value' });
    expect(cells[14]).toMatchObject({ value: null, state: 'gap' });
  });

  test('four shades above zero; zero and missing values stay unshaded', () => {
    expect([0, 1, 25, 26, 50, 99, 100].map((v) => heatLevel(v, 100))).toEqual([
      0, 1, 1, 2, 2, 4, 4,
    ]);
    expect(heatLevel(null, 100)).toBe(0);
    expect(heatLevel(5, 0)).toBe(0);
  });

  test('an hour drills down within the window the server answered for, not the one asked for', () => {
    const now = Date.UTC(2026, 0, 3, 12, 30);
    const query = rangeQuery('24h', now);
    // The served snapshot ends an hour before the page's clock; its first hour starts earlier.
    const served = {
      from_ms: query.from_ms - HOUR,
      to_ms: query.to_ms - HOUR,
      granularity: 'hour' as const,
    };
    const first = Math.floor(served.from_ms / HOUR) * HOUR;
    expect(servedBucketQuery(query, served, first)).toMatchObject({
      from_ms: served.from_ms,
      to_ms: first + HOUR,
    });
  });
});

describe('hour heatmap', () => {
  const from = Date.UTC(2026, 0, 2, 0);
  const to = from + DAY;
  const render = (
    hourly: boolean,
    points = new Map([
      [from + 3 * HOUR, 4],
      [from + 14 * HOUR, 40],
      [from + 15 * HOUR, 0],
    ])
  ) =>
    renderToStaticMarkup(
      createElement(HourHeatmap, {
        title: 'Events by hour · UTC',
        points,
        from,
        to,
        hourly,
        onSelect: noop,
        onShowHourly: noop,
      })
    );

  test('a daily view offers hourly buckets instead of drawing a map', () => {
    const markup = render(false);
    expect(markup).toContain('The hour map needs hourly buckets.');
    expect(markup).toContain('>Show by hour</button>');
    expect(markup).not.toContain('data-at=');
  });

  test('every hour is named; one tab stop, on the busiest hour', () => {
    const markup = render(true);
    expect(markup.match(/<button[^>]*data-at=/g)).toHaveLength(24);
    expect(markup.match(/tabindex="0"/g)?.length).toBe(2); // the busiest cell + the table region
    expect(markup).toMatch(/data-level="4" tabindex="0" aria-label="Jan 2, 14:00 UTC: 40 events"/);
    expect(markup).toContain('aria-label="Jan 2, 15:00 UTC: 0 events"');
  });

  test('an unmeasured hour says so, in the grid and the table; an all-unmeasured map keeps a tab stop', () => {
    const markup = render(true, new Map());
    expect(markup).toContain('aria-label="Jan 2, 00:00 UTC: not measured"');
    expect(markup).toContain('<td>not measured</td>');
    expect(markup).toMatch(/data-state="gap"[^>]*tabindex="0" aria-label="Jan 2, 00:00 UTC/);
  });
});

describe('where the map shows', () => {
  const overview = (range: 'today' | '1h') =>
    renderToStaticMarkup(
      createElement(AnalyticsViews, {
        tab: 'overview',
        data: analyticsScenario('ready', rangeQuery(range, Date.UTC(2026, 0, 2, 12))),
        onBucket: noop,
        onModel: noop,
        onProvider: noop,
        onShowHourly: noop,
      })
    );
  test('Today at noon has a map; the last hour alone has nothing to compare', () => {
    expect(overview('today')).toContain('Events by hour · UTC');
    expect(overview('1h')).not.toContain('Events by hour · UTC');
  });
});
