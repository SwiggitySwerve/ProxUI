import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import type { PoolDashboard, PoolPoint, QuotaPool } from '../src/domain/quotaPool/types';
import { PoolCard } from '../src/features/quotaPool/PoolCard';
import { PoolComparisonChart } from '../src/features/quotaPool/PoolChart';
import { poolChip } from '../src/features/quotaPool/model/poolChip';

const point = (atMs: number, remainingPoints: number): PoolPoint => ({
  atMs,
  remainingPoints,
  burnPointsPerHour: 26,
  drainPointsPerHour: 26,
});
// Shaped like the live Gemini pool after its source was retired (ProxUI #129).
const account: QuotaPool['accounts'][number] = {
  id: 'opaque-retired',
  label: 'Gemini 1',
  disabled: true,
  status: 'disabled',
  observedAtMs: 300,
  remainingPercent: 92.9,
  resetAtMs: 900,
  burnPointsPerHour: null,
  emptyAtMs: null,
  plan: { label: 'Ultra', capacityPoints: 2000, known: true },
  windows: [],
};
const retired: QuotaPool = {
  provider: 'antigravity',
  instanceId: 'gemini-primary',
  sourceLabel: 'gemini-primary',
  accountCount: 1,
  eligibleCount: 0,
  loadedCount: 0,
  capacityPoints: 0,
  remainingPoints: null,
  burnPointsPerHour: null,
  drainPointsPerHour: null,
  forecastState: 'partial',
  firstEmptyAtMs: null,
  poolEmptyAtMs: null,
  nextResetAtMs: null,
  nextResetGainPoints: null,
  recorded: [point(100, 1858.8), point(300, 1840)],
  projected: [],
  resets: [],
  accounts: [account],
};
const dashboard: PoolDashboard = {
  nowMs: 500,
  fromMs: 0,
  toMs: 1000,
  window: 'weekly',
  lookbackHours: 3,
  multiplier: 1,
  historyStartedAtMs: 100,
  lastRefreshAtMs: 500,
  nextRefreshAtMs: 60_500,
  refreshing: false,
  issues: [],
  pools: [retired],
};
const card = (pool: QuotaPool) =>
  renderToStaticMarkup(createElement(PoolCard, { pool, dashboard, mode: 'remaining', reveal: false }));

describe('a retired source', () => {
  test('its card shows history only, with no warning, total, forecast or coverage count', async () => {
    await i18n.changeLanguage('en');
    const markup = card(retired);
    expect(markup).toContain('History only');
    expect(markup).toContain('Not collected');
    expect(markup).toContain('data-state="retired"');
    expect(markup).toContain('No longer collected: this source was retired.');
    expect(markup).not.toContain('Withheld');
    expect(markup).not.toContain('some eligible accounts have no current quota data');
    expect(markup).not.toContain('data-group="forecast"');
    expect(markup).not.toContain('Reporting');
  });

  test('a pool with one live account is not retired', async () => {
    await i18n.changeLanguage('en');
    const live = { ...account, id: 'opaque-live', disabled: false, status: 'error' as const };
    const markup = card({ ...retired, accountCount: 2, eligibleCount: 1, accounts: [account, live] });
    expect(markup).not.toContain('History only');
    expect(markup).toContain('Withheld');
    expect(markup).toContain('data-group="forecast"');
  });

  test('its chip is neutral and has an icon of its own', () => {
    expect(poolChip('partial', false, true)).toEqual({
      state: 'retired',
      icon: 'retired',
      tone: 'neutral',
    });
    // Saved data during a retry still wins: the page-wide banner explains it.
    expect(poolChip('partial', true, true).state).toBe('saved');
  });

  test('the Combined legend calls its layer history only, not partial', async () => {
    await i18n.changeLanguage('en');
    const live: QuotaPool = {
      ...retired,
      provider: 'claude',
      instanceId: 'claude-primary',
      sourceLabel: undefined,
      capacityPoints: 200,
      remainingPoints: 60,
      forecastState: 'ready',
      recorded: [point(100, 80), point(300, 60)],
      accounts: [],
    };
    const markup = renderToStaticMarkup(
      createElement(PoolComparisonChart, {
        pools: [live, { ...retired, historyOnly: true }],
        dashboard,
        mode: 'remaining',
      })
    );
    expect(markup).toContain('History only');
    expect(markup).not.toContain('Partial');
  });
});
