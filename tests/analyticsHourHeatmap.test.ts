import { beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { heatLevel, hourGrid } from '../src/features/analytics/chartGeometry';
import { HourHeatmap } from '../src/features/analytics/HourHeatmap';

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
    const rows = hourGrid(new Map(), from, to, true);
    expect(rows.map((row) => row.day)).toEqual([day, day + DAY]);
    expect(rows[0].cells[9].state).toBe('outside');
    // 10:00 holds 10:30, so it is in the window.
    expect(rows[0].cells[10].state).toBe('quiet');
    expect(rows[1].cells[10].state).toBe('quiet');
    expect(rows[1].cells[11].state).toBe('outside');
  });

  test('an absent hour is a quiet zero only with complete coverage, otherwise a gap', () => {
    const values = new Map([[day + 12 * HOUR, 7]]);
    const complete = hourGrid(values, from, to, true)[0].cells;
    expect(complete[12]).toEqual({ at: day + 12 * HOUR, value: 7, state: 'value' });
    expect(complete[13]).toMatchObject({ value: 0, state: 'quiet' });
    const partial = hourGrid(values, from, to, false)[0].cells;
    expect(partial[13]).toMatchObject({ value: null, state: 'gap' });
  });

  test('four shades above zero; zero and missing values stay unshaded', () => {
    expect([0, 1, 25, 26, 50, 99, 100].map((v) => heatLevel(v, 100))).toEqual([
      0, 1, 1, 2, 2, 4, 4,
    ]);
    expect(heatLevel(null, 100)).toBe(0);
    expect(heatLevel(5, 0)).toBe(0);
  });
});

describe('hour heatmap', () => {
  const from = Date.UTC(2026, 0, 2, 0);
  const to = from + DAY;
  const render = (hourly: boolean, rawComplete = true) =>
    renderToStaticMarkup(
      createElement(HourHeatmap, {
        title: 'Events by hour · UTC',
        points: new Map([
          [from + 3 * HOUR, 4],
          [from + 14 * HOUR, 40],
        ]),
        from,
        to,
        hourly,
        rawComplete,
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

  test('with partial coverage an absent hour says it was not measured', () => {
    const markup = render(true, false);
    expect(markup).toContain('aria-label="Jan 2, 15:00 UTC: not measured"');
    expect(markup).toContain('data-state="gap"');
  });
});
