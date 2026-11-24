import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import type { PoolDashboard, PoolPoint, QuotaPool } from '../src/domain/quotaPool/types';
import { ResetFact } from '../src/features/quotaPool/PoolAccountResets';
import { PoolChart } from '../src/features/quotaPool/PoolChart';

// Gaps the live page showed after ProxUI #130 that no fixture covered (ProxUI #134).

const account: QuotaPool['accounts'][number] = {
  id: 'opaque-1',
  label: 'Claude 1',
  disabled: false,
  status: 'ok',
  observedAtMs: 500,
  remainingPercent: 40,
  resetAtMs: 900,
  burnPointsPerHour: 3,
  emptyAtMs: null,
  plan: { label: 'Ultra', capacityPoints: 2000, known: true },
  windows: [],
};
const resets = (available: number, usable: number) => ({
  available,
  usable,
  blocker: null,
  nextExpiryAtMs: null,
  observedAtMs: 500,
});
const resetCard = (available: number, usable: number, disabled: boolean) =>
  renderToStaticMarkup(
    createElement(ResetFact, {
      account: { ...account, resets: resets(available, usable) },
      name: 'res•••ch@ex•••.test',
      provider: 'claude',
      onRefresh: () => {},
      spent: false,
      disabled,
    })
  );

/** The Use reset button's opening tag, and the text of the note it points at (null when none). */
const resetButton = (markup: string) => {
  const button = markup.match(/<button[^>]*>/)?.[0];
  if (!button) throw new Error('no Use reset button');
  const id = button.match(/aria-describedby="([^"]+)"/)?.[1];
  const note = id ? markup.match(new RegExp(`<p id="${id}"[^>]*>([^<]*)</p>`))?.[1] : undefined;
  return { enabled: !/\sdisabled=/.test(button), described: id !== undefined, note: note ?? null };
};

describe('Use reset over resets that are all usable', () => {
  test('an enabled button has no "Usable now" note and describes nothing', async () => {
    await i18n.changeLanguage('en');
    const markup = resetCard(1, 1, false);
    expect(resetButton(markup)).toEqual({ enabled: true, described: false, note: null });
    expect(markup).not.toContain('Usable now');
    expect(markup).not.toContain('Not usable now');
  });

  test('a partial count still says how many are usable, as the button does not', async () => {
    await i18n.changeLanguage('en');
    expect(resetButton(resetCard(3, 1, false))).toEqual({
      enabled: true,
      described: true,
      note: '1 usable now',
    });
  });

  test('a disabled button keeps its note', async () => {
    await i18n.changeLanguage('en');
    expect(resetButton(resetCard(1, 1, true))).toEqual({
      enabled: false,
      described: true,
      note: 'Usable now',
    });
  });
});

const point = (atMs: number, remainingPoints: number): PoolPoint => ({
  atMs,
  remainingPoints,
  burnPointsPerHour: 3,
  drainPointsPerHour: 3,
});
const dashboard: PoolDashboard = {
  nowMs: 500,
  fromMs: 0,
  toMs: 1000,
  window: 'weekly',
  lookbackHours: 3,
  multiplier: 1,
  historyStartedAtMs: 0,
  lastRefreshAtMs: 500,
  nextRefreshAtMs: 60_500,
  refreshing: false,
  issues: [],
  pools: [],
};
const chartPool = (capacityPoints: number, values: number[]): QuotaPool => ({
  provider: 'claude',
  accountCount: 1,
  eligibleCount: 1,
  loadedCount: 1,
  capacityPoints,
  remainingPoints: values.at(-1) ?? null,
  burnPointsPerHour: 3,
  drainPointsPerHour: 3,
  forecastState: 'ready',
  firstEmptyAtMs: null,
  poolEmptyAtMs: null,
  nextResetAtMs: null,
  nextResetGainPoints: null,
  recorded: values.map((value, index) => point(100 + index * 100, value)),
  projected: [],
  resets: [],
  accounts: [account],
});
/** Where the y axis labels end: the gutter's right edge. */
const gutter = (pool: QuotaPool) => {
  const markup = renderToStaticMarkup(
    createElement(PoolChart, {
      pool,
      dashboard: { ...dashboard, pools: [pool] },
      mode: 'remaining',
    })
  );
  const label = markup.match(/<text x="([\d.]+)"[^>]*text-anchor="end"[^>]*>0<\/text>/);
  if (!label) throw new Error('no y axis label in the chart');
  return Number(label[1]);
};

describe('the y axis gutter', () => {
  test('widens when the data tops capacity, so its top label does not clip', () => {
    // A retired pool: no capacity, and the axis tops out at its largest reading, "1,858.8".
    expect(gutter(chartPool(0, [1858.8, 1840]))).toBeGreaterThan(
      gutter(chartPool(2000, [1800, 1700]))
    );
    // With capacity too: a reading above 2,000 tops the axis at "25,000.5", wider than "2,000".
    expect(gutter(chartPool(2000, [25_000.5, 1700]))).toBeGreaterThan(
      gutter(chartPool(2000, [1800, 1700]))
    );
  });

  test('keeps its width when the data stays inside capacity', () => {
    // "142.8" is longer than "200", but the axis labels 0, 100 and 200, so nothing moves.
    expect(gutter(chartPool(200, [142.8, 140.1]))).toBe(gutter(chartPool(200, [100, 90])));
  });

  test('ignores a reading outside the range it draws', () => {
    const pool = chartPool(200, [100, 90]);
    // Past the view's end (toMs 1000) and past the one neighbour kept so lines reach the edge: never
    // plotted, so it must not widen the axis.
    const offRange = {
      ...pool,
      recorded: [...pool.recorded, point(2000, 90), point(3000, 500_000)],
    };
    expect(gutter(offRange)).toBe(gutter(pool));
  });
});
