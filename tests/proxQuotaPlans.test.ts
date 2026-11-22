import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDashboard, projectPool } from '../server/quota/domain';
import {
  planAt,
  planChangeSuspected,
  planFromClaudeProfile,
  planFromCodexUsage,
  planWeight,
} from '../server/quota/plans';
import { QuotaStore } from '../server/quota/store';
import type { QuotaSample, StoredAccount } from '../server/quota/types';
import { HOUR_MS } from '../server/quota/types';

const now = Date.UTC(2026, 9, 28, 12);
const account = (id: string, provider: 'claude' | 'codex', plan?: string): StoredAccount => ({
  id,
  provider,
  name: `${id}.json`,
  email: null,
  disabled: false,
  retired: false,
  lastSeenAtMs: now,
  lastErrorAtMs: null,
  ...(plan ? { plan } : {}),
});
const samples = (id: string, from: number, to: number): QuotaSample[] =>
  [0, 1, 2].map((step) => ({
    accountId: id,
    window: 'weekly',
    observedAtMs: now - (2 - step) * 600_000,
    remainingPercent: from - ((from - to) * step) / 2,
    resetAtMs: now + 24 * HOUR_MS,
    periodHours: 168,
  }));
const dashboard = (accounts: StoredAccount[], rows: QuotaSample[]) =>
  buildDashboard(
    accounts,
    rows,
    { nowMs: now, window: 'weekly', lookbackHours: 3, multiplier: 1, offsetDays: 0, reveal: false },
    {
      historyStartedAtMs: now,
      lastRefreshAtMs: now,
      nextRefreshAtMs: now,
      refreshing: false,
      issues: [],
    }
  );

describe('plan weights', () => {
  test('use each provider base plan as one unit', () => {
    expect(planWeight('claude', 'default_claude_max_20x')).toEqual({
      multiplier: 20,
      label: 'Ultra',
      known: true,
    });
    expect(planWeight('claude', 'default_claude_max_5x')).toEqual({
      multiplier: 5,
      label: 'Max',
      known: true,
    });
    // Anthropic renamed Max 20x to Ultra on 2026-10-30; the profile may report either tier name.
    expect(planWeight('claude', 'default_claude_ultra')).toEqual({
      multiplier: 20,
      label: 'Ultra',
      known: true,
    });
    expect(planWeight('claude', 'claude_pro')).toEqual({
      multiplier: 1,
      label: 'Pro',
      known: true,
    });
    expect(planWeight('codex', 'plus')).toEqual({ multiplier: 1, label: 'Plus', known: true });
    expect(planWeight('codex', 'pro')).toEqual({ multiplier: 10, label: 'Pro', known: true });
    expect(planWeight('codex', 'promax')).toEqual({
      multiplier: 25,
      label: 'Pro 500',
      known: true,
    });
  });
  test('an unknown or missing plan counts once and says so', () => {
    expect(planWeight('codex', 'enterprise')).toEqual({
      multiplier: 1,
      label: 'enterprise',
      known: false,
    });
    expect(planWeight('claude', undefined)).toEqual({ multiplier: 1, label: null, known: false });
  });
  test('a discovered provider weights only plans it names; a missing plan stays unknown', () => {
    const units = { 'team-plan': 4, '*': 9 };
    expect(planWeight('zcode', 'team-plan', units)).toEqual({
      multiplier: 4,
      label: 'team-plan',
      known: true,
    });
    // An operator's weight never reaches an account that reports no plan.
    for (const plan of [null, undefined])
      expect(planWeight('zcode', plan, units)).toEqual({
        multiplier: 1,
        label: null,
        known: false,
      });
  });
  test('read the plan from provider responses', () => {
    expect(planFromCodexUsage({ plan_type: 'promax', rate_limit: {} })).toBe('promax');
    expect(planFromCodexUsage('{"plan_type":"pro"}')).toBe('pro');
    expect(planFromCodexUsage({})).toBeNull();
    expect(
      planFromClaudeProfile({
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
        },
      })
    ).toBe('default_claude_max_20x');
    expect(planFromClaudeProfile({ organization: { organization_type: 'claude_pro' } })).toBe(
      'claude_pro'
    );
    // A tier the table does not know falls back to the organization type.
    expect(
      planFromClaudeProfile({
        organization: { organization_type: 'claude_pro', rate_limit_tier: 'default_claude_ai' },
      })
    ).toBe('claude_pro');
    expect(planFromCodexUsage({ plan_type: ' Pro ' })).toBe('pro');
    expect(planFromClaudeProfile('not json')).toBeNull();
  });
});

describe('weighted pools', () => {
  test('points follow plan weight: Pro 500 counts 2.5 times Pro 200', () => {
    const pool = dashboard(
      [account('research', 'codex', 'promax'), account('normal', 'codex', 'pro')],
      [...samples('research', 50, 40), ...samples('normal', 50, 40)]
    ).pools.find((p) => p.provider === 'codex')!;
    expect(pool.capacityPoints).toBe(3500);
    expect(pool.remainingPoints).toBe(1400); // 40% of 2500 + 40% of 1000
    expect(pool.burnPointsPerHour).toBeCloseTo(1050); // 30%/h of 2500 + 30%/h of 1000
    const research = pool.accounts.find((a) => a.id === 'research')!;
    expect(research.remainingPercent).toBe(40);
    expect(research.plan).toEqual({ label: 'Pro 500', capacityPoints: 2500, known: true });
    expect(pool.recorded.at(-1)?.remainingPoints).toBe(1400);
  });
  test('an account without a known plan stays at 100 points', () => {
    const pool = dashboard([account('a', 'claude')], samples('a', 80, 60)).pools.find(
      (p) => p.provider === 'claude'
    )!;
    expect(pool.capacityPoints).toBe(100);
    expect(pool.accounts[0].plan).toEqual({ label: null, capacityPoints: 100, known: false });
  });
  test('a reset restores each account to its own capacity', () => {
    const { resets } = projectPool(
      [
        { remaining: 500, rate: 0, resetAtMs: now + HOUR_MS, periodHours: 168, capacity: 2500 },
        { remaining: 0, rate: 0, resetAtMs: now + HOUR_MS, periodHours: 168, capacity: 1000 },
      ],
      now,
      now + 2 * HOUR_MS
    );
    expect(resets[0].gainPoints).toBe(3000);
  });
});

describe('plan history', () => {
  const MIN = 60_000;
  // Ultra Lite until 12 minutes ago, then Ultra: the upgrade opened a fresh weekly window.
  const gemini: StoredAccount = {
    id: 'g',
    provider: 'antigravity',
    name: 'g.json',
    email: null,
    disabled: false,
    retired: false,
    lastSeenAtMs: now,
    lastErrorAtMs: null,
    plan: 'g1-ultra-tier',
    planHistory: [
      { plan: 'g1-ultra-lite-tier', fromMs: 0 },
      { plan: 'g1-ultra-tier', fromMs: now - 12 * MIN },
    ],
  };
  const reading = (
    minutesAgo: number,
    remainingPercent: number,
    resetAtMs: number
  ): QuotaSample => ({
    accountId: 'g',
    window: 'weekly',
    observedAtMs: now - minutesAgo * MIN,
    remainingPercent,
    resetAtMs,
    periodHours: 168,
  });
  const before = now + 24 * HOUR_MS;
  const after = now + 7 * 24 * HOUR_MS;
  const rows = [
    reading(25, 80, before),
    reading(20, 60, before),
    reading(15, 40, before),
    reading(10, 100, after),
    reading(5, 98, after),
    reading(0, 96, after),
  ];

  test('a plan applies from when it took effect; earlier plans before that', () => {
    expect(planAt(gemini, now - 20 * MIN)).toBe('g1-ultra-lite-tier');
    expect(planAt(gemini, now - 12 * MIN)).toBe('g1-ultra-tier');
    expect(planAt({ plan: 'pro' }, now)).toBe('pro');
  });

  test('an upgrade leaves earlier readings on the old plan scale and burns no points', () => {
    const pool = dashboard([gemini], rows).pools.find((p) => p.provider === 'antigravity')!;
    expect(pool.capacityPoints).toBe(2000);
    expect(pool.remainingPoints).toBe(1920);
    const at = (minutesAgo: number) =>
      pool.recorded.find((point) => point.atMs === now - minutesAgo * MIN)?.remainingPoints;
    // Ultra Lite counts 5 base plans: 80% was 400 points, not 1600.
    expect(at(25)).toBe(400);
    expect(at(15)).toBe(200);
    expect(at(10)).toBe(2000);
    // 2 x 20% of 500 and 2 x 2% of 2000 over 20 minutes; the step across the upgrade is no burn.
    expect(pool.burnPointsPerHour).toBeCloseTo(840, 6);
  });

  test('a reading carried to a later chart time keeps the plan it was read under', () => {
    // A Claude reading after the upgrade adds a shared chart time; Gemini's 15-minutes-ago
    // Ultra Lite reading is still its current one there and stays at the Ultra Lite scale.
    const claude = { ...account('c', 'claude'), plan: 'default_claude_max_20x' };
    const claudeRows: QuotaSample[] = [25, 11].map((minutesAgo) => ({
      accountId: 'c',
      window: 'weekly',
      observedAtMs: now - minutesAgo * MIN,
      remainingPercent: 50,
      resetAtMs: after,
      periodHours: 168,
    }));
    const geminiRows = rows.filter((row) => row.observedAtMs <= now - 15 * MIN);
    const all = dashboard([gemini, claude], [...geminiRows, ...claudeRows]).combined?.all;
    const at = (minutesAgo: number) =>
      all?.series?.recorded.find((point) => point.atMs === now - minutesAgo * MIN)?.remainingPoints;
    // 40% of Ultra Lite (200) plus 50% of Claude Ultra (1000), not 40% of Ultra (800) + 1000.
    expect(at(11)).toBe(1200);
  });

  test('a live balance read before a plan change keeps that plan; the forecast waits', () => {
    // The change was recorded a minute ago without a new reading (e.g. a paused pool profile).
    const changed: StoredAccount = {
      ...gemini,
      planHistory: [
        { plan: 'g1-ultra-lite-tier', fromMs: 0 },
        { plan: 'g1-ultra-tier', fromMs: now - MIN },
      ],
    };
    const lite = [reading(9, 44, before), reading(6, 42, before), reading(3, 40, before)];
    const pool = dashboard([changed], lite).pools.find((p) => p.provider === 'antigravity')!;
    expect(pool.remainingPoints).toBe(200);
    expect(pool.recorded.at(-1)?.remainingPoints).toBe(200);
    expect(pool.forecastState).toBe('collecting');
  });

  test('a downgrade mid-window is not consumption', () => {
    const downgraded: StoredAccount = {
      ...gemini,
      plan: 'g1-ultra-lite-tier',
      planHistory: [
        { plan: 'g1-ultra-tier', fromMs: 0 },
        { plan: 'g1-ultra-lite-tier', fromMs: now - 7 * MIN },
      ],
    };
    const sameWindow = [
      reading(15, 90, after),
      reading(10, 88, after),
      reading(5, 86, after),
      reading(0, 84, after),
    ];
    const pool = dashboard([downgraded], sameWindow).pools.find(
      (p) => p.provider === 'antigravity'
    )!;
    // 2% of 2000 per 5 minutes before, 2% of 500 after; the 10 -> 5 step crosses the change.
    expect(pool.burnPointsPerHour).toBeCloseTo((40 + 10) * 6, 6);
  });
});

describe('plan change signal', () => {
  const window = (remainingPercent: number, resetAtMs: number) => ({
    id: 'five-hour',
    labelKey: 'five-hour',
    remainingPercent,
    resetAtMs,
  });
  const later = now + 3 * HOUR_MS;
  test('a window in use that restarts before its reset suggests a plan change', () => {
    expect(planChangeSuspected([window(0.2, later)], [window(100, now + 5 * HOUR_MS)], now)).toBe(
      true
    );
  });
  test('a move of 20 points within one cycle suggests a plan change, usage does not', () => {
    expect(planChangeSuspected([window(40, later)], [window(85, later)], now)).toBe(true);
    expect(planChangeSuspected([window(90, later)], [window(30, later + 30_000)], now)).toBe(true);
    expect(planChangeSuspected([window(90, later)], [window(82, later)], now)).toBe(false);
  });
  test('scheduled resets, idle windows and first readings do not', () => {
    // The window reset on time.
    expect(
      planChangeSuspected([window(10, now - 1000)], [window(100, now + 5 * HOUR_MS)], now)
    ).toBe(false);
    // An unused window slides its reset every poll.
    expect(planChangeSuspected([window(100, later)], [window(100, later + 300_000)], now)).toBe(
      false
    );
    expect(planChangeSuspected(undefined, [window(50, later)], now)).toBe(false);
  });
});

describe('plan persistence', () => {
  const stores: QuotaStore[] = [];
  afterEach(() => stores.splice(0).forEach((s) => s.close()));
  test('stores the latest plan per account and lists it', () => {
    const store = new QuotaStore(':memory:');
    stores.push(store);
    store.recordInventory('codex', [account('x', 'codex')], now);
    expect(store.listAccounts()[0].plan).toBeUndefined();
    store.recordPlan('x', 'pro', now);
    store.recordPlan('x', 'promax', now + 1);
    expect(store.listAccounts()[0]).toMatchObject({ plan: 'promax', planObservedAtMs: now + 1 });
  });
  test('keeps each plan change with the time it was first seen', () => {
    const store = new QuotaStore(':memory:');
    stores.push(store);
    store.recordInventory('codex', [account('x', 'codex')], now);
    store.recordPlan('x', 'pro', now);
    store.recordPlan('x', 'pro', now + 1);
    store.recordPlan('x', 'promax', now + 2);
    store.recordPlan('x', 'promax', now + 3);
    // The first plan holds from the start: the account's first samples precede the plan read.
    expect(store.listAccounts()[0].planHistory).toEqual([
      { plan: 'pro', fromMs: 0 },
      { plan: 'promax', fromMs: now + 2 },
    ]);
  });
  test('a discovered reading without a plan keeps the earlier plans for earlier readings', () => {
    const store = new QuotaStore(':memory:');
    stores.push(store);
    store.recordInventory('codex', [account('x', 'codex')], now);
    store.recordDiscoveredReading('x', now, 'five', []);
    store.recordDiscoveredReading('x', now + 1, null, []);
    store.recordDiscoveredReading('x', now + 2, null, []);
    store.recordDiscoveredReading('x', now + 3, 'twenty', []);
    const [x] = store.listAccounts();
    expect(x.planHistory).toEqual([
      { plan: 'five', fromMs: 0 },
      { plan: '', fromMs: now + 1 },
      { plan: 'twenty', fromMs: now + 3 },
    ]);
    expect([0, now + 1, now + 3].map((atMs) => planAt(x, atMs))).toEqual([
      'five',
      undefined,
      'twenty',
    ]);
  });
  test('a discovered account that first names no plan keeps its early readings unknown', () => {
    const store = new QuotaStore(':memory:');
    stores.push(store);
    store.recordInventory('codex', [account('x', 'codex')], now);
    store.recordDiscoveredReading('x', now, null, []);
    store.recordDiscoveredReading('x', now + 1, 'five', []);
    expect(store.listAccounts()[0].planHistory).toEqual([
      { plan: '', fromMs: 0 },
      { plan: 'five', fromMs: now + 1 },
    ]);
  });
  test('a plan stored before the history existed holds from the start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prox-plan-history-'));
    try {
      const path = join(dir, 'quota.sqlite');
      const first = new QuotaStore(path);
      first.recordInventory('codex', [account('x', 'codex')], now);
      first.recordPlan('x', 'pro', now);
      first.close();
      const legacy = new Database(path);
      legacy.exec('DELETE FROM quota_plan_history');
      legacy.close();
      const reopened = new QuotaStore(path);
      stores.push(reopened);
      expect(reopened.listAccounts()[0].planHistory).toEqual([{ plan: 'pro', fromMs: 0 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
