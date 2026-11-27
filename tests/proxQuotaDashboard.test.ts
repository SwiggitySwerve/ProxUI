import { afterEach, describe, expect, jest, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import i18n from '../src/i18n';
import type { PoolDashboard, PoolPoint, QuotaPool } from '../src/domain/quotaPool/types';
import type { PoolQuery, PoolRefresh } from '../src/services/api/quotaPool';
import {
  axisTicks,
  chartGeometry,
  chartSamples,
  dayTicks,
  hourTicks,
  inRange,
  viewRange,
  fitChartFrame,
} from '../src/features/quotaPool/chartGeometry';
import {
  buildLaneStops,
  findNextReset,
  nextResetStopIndex,
  placeLaneResets,
  placeTotalResetTicks,
  selectStopAtX,
} from '../src/features/quotaPool/combinedLanesModel';
import { createPoolResource } from '../src/features/quotaPool/poolResource';
import { createPoolSessionObserver } from '../src/features/quotaPool/poolSession';
import { useAuthStore } from '../src/stores/useAuthStore';
import { PoolCard } from '../src/features/quotaPool/PoolCard';
import { CombinedPoolCard } from '../src/features/quotaPool/CombinedPoolCard';
import { CombinedLanesChart } from '../src/features/quotaPool/CombinedLanesChart';
import { PoolChart } from '../src/features/quotaPool/PoolChart';
import { sortAccounts } from '../src/features/quotaPool/model/accountOrder';

const point = (atMs: number, remainingPoints: number | null): PoolPoint => ({
  atMs,
  remainingPoints,
  burnPointsPerHour: remainingPoints === null ? null : 3,
  drainPointsPerHour: remainingPoints === null ? null : -2,
});
const pool: QuotaPool = {
  provider: 'claude',
  accountCount: 2,
  eligibleCount: 2,
  loadedCount: 1,
  capacityPoints: 200,
  remainingPoints: 73,
  burnPointsPerHour: 3,
  drainPointsPerHour: -2,
  forecastState: 'partial',
  firstEmptyAtMs: null,
  poolEmptyAtMs: null,
  nextResetAtMs: 800,
  nextResetGainPoints: 100,
  recorded: [point(100, 80), point(300, null), point(500, 73)],
  projected: [point(500, 73), point(800, 70), point(800, 170), point(900, 160)],
  resets: [{ atMs: 800, gainPoints: 100 }],
  accounts: [
    {
      id: 'opaque-1',
      label: 'Claude account 1',
      email: 'private@example.test',
      disabled: false,
      status: 'ok',
      observedAtMs: 500,
      remainingPercent: 73,
      resetAtMs: 800,
      burnPointsPerHour: 3,
      emptyAtMs: null,
      plan: { label: 'Max 20x', capacityPoints: 2000, known: true },
      windows: [
        {
          id: 'five-hour',
          labelKey: 'claude_quota.five_hour',
          remainingPercent: 12,
          resetAtMs: 800,
        },
        {
          id: 'seven-day-opus',
          labelKey: 'claude_quota.seven_day_opus',
          remainingPercent: 64,
          resetAtMs: null,
        },
      ],
    },
  ],
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
  pools: [pool],
};
const query: PoolQuery = {
  window: 'weekly',
  lookback: 3,
  multiplier: 1,
  offsetDays: 0,
  reveal: false,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
});

describe('pool request lifetime', () => {
  test('targeted refresh awaits its reading before reload and silently falls back when unavailable', async () => {
    const reading = deferred<{ refreshed: boolean }>();
    let reads = 0;
    let full = 0;
    const ids: string[] = [];
    const resource = createPoolResource(
      {
        get: async () => {
          reads++;
          return dashboard;
        },
        refresh: async () => {
          full++;
          throw new Error('offline');
        },
        refreshAccount: (id) => {
          ids.push(id);
          return reading.promise;
        },
      },
      query,
      () => true
    );
    disposers.push(resource.subscribe(() => {}));
    await flush();
    const refresh = resource.refresh('account');
    expect(reads).toBe(1);
    reading.resolve({ refreshed: true });
    await refresh;
    expect(ids).toEqual(['account']);
    expect(reads).toBe(2);
    expect(full).toBe(0);
    const fallback = createPoolResource(
      {
        get: async () => {
          reads++;
          return dashboard;
        },
        refresh: async () => {
          full++;
          throw new Error('offline');
        },
        refreshAccount: async () => {
          throw new Error('offline');
        },
      },
      query,
      () => true
    );
    disposers.push(fallback.subscribe(() => {}));
    await flush();
    await fallback.refresh('account');
    expect(full).toBe(1);
    expect(reads).toBe(4);
    expect(fallback.getSnapshot().refreshError).toBe(false);
  });

  test('same-credential reconnects invalidate the session even when React batches transitions', () => {
    const previous = useAuthStore.getState();
    const storage = useAuthStore.persist.getOptions().storage;
    useAuthStore.persist.setOptions({
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    useAuthStore.setState({ isAuthenticated: true, connectionStatus: 'connected' });
    const session = createPoolSessionObserver();
    const unsubscribe = session.subscribe(() => {});
    try {
      const initial = session.getSnapshot();
      useAuthStore.setState({ connectionStatus: 'connecting' });
      useAuthStore.setState({ connectionStatus: 'connected' });
      expect(session.getSnapshot()).toBe(initial + 2);
      useAuthStore.setState({ serverVersion: 'test-version' });
      expect(session.getSnapshot()).toBe(initial + 2);
    } finally {
      unsubscribe();
      useAuthStore.setState(previous);
      useAuthStore.persist.setOptions({ storage });
    }
  });

  test('latest read wins even when the aborted transport still resolves', async () => {
    const first = deferred<PoolDashboard>();
    const second = deferred<PoolDashboard>();
    const signals: AbortSignal[] = [];
    let calls = 0;
    const resource = createPoolResource(
      {
        get: (_query, signal) => {
          signals.push(signal);
          return ++calls === 1 ? first.promise : second.promise;
        },
        refresh: async () => dashboard,
      },
      query,
      () => true
    );
    disposers.push(resource.subscribe(() => {}));
    const newer = resource.reload();
    second.resolve({ ...dashboard, nowMs: 600 });
    await newer;
    first.resolve(dashboard);
    await flush();
    expect(signals[0].aborted).toBe(true);
    expect(resource.getSnapshot().data?.nowMs).toBe(600);
  });

  test('failed reads and refreshes keep the HTTP status, or null when nothing answered', async () => {
    let failure: unknown = Object.assign(new Error('Service unavailable'), { status: 503 });
    const resource = createPoolResource(
      {
        get: async () => {
          throw failure;
        },
        refresh: async () => {
          throw failure;
        },
      },
      query,
      () => true
    );
    disposers.push(resource.subscribe(() => {}));
    await flush();
    expect(resource.getSnapshot()).toMatchObject({ error: true, errorStatus: 503 });
    failure = new Error('Network Error');
    await resource.refresh();
    expect(resource.getSnapshot()).toMatchObject({ refreshError: true, refreshErrorStatus: null });
  });

  test('session revision changes reject reads and refreshes; stale sessions cannot start work', async () => {
    let revision = 1;
    const read = deferred<PoolDashboard>();
    const refresh = deferred<PoolRefresh>();
    let reads = 0;
    const resource = createPoolResource(
      {
        get: () => {
          reads++;
          return read.promise;
        },
        refresh: () => refresh.promise,
      },
      query,
      () => revision === 1
    );
    disposers.push(resource.subscribe(() => {}));
    const pending = resource.refresh();
    revision = 3; // A → B → A: credentials may match, generation must not.
    read.resolve(dashboard);
    refresh.resolve(dashboard);
    await pending;
    await resource.reload();
    expect(resource.getSnapshot().data).toBeNull();
    expect(reads).toBe(1);
  });

  test('unmount/privacy/filter cleanup aborts and discards sensitive data', async () => {
    const response = deferred<PoolDashboard>();
    let signal: AbortSignal | undefined;
    const resource = createPoolResource(
      {
        get: (_query, nextSignal) => {
          signal = nextSignal;
          return response.promise;
        },
        refresh: async () => dashboard,
      },
      { ...query, reveal: true },
      () => true
    );
    const unsubscribe = resource.subscribe(() => {});
    unsubscribe();
    response.resolve(dashboard);
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(resource.getSnapshot().data).toBeNull();
  });

  test('refresh is deduplicated, refetches the current query, and exposes failure', async () => {
    const mutation = deferred<PoolRefresh>();
    let refreshes = 0;
    const queries: PoolQuery[] = [];
    const resource = createPoolResource(
      {
        get: async (params) => {
          queries.push(params);
          return dashboard;
        },
        refresh: () => {
          refreshes++;
          return mutation.promise;
        },
      },
      { ...query, window: 'five-hour', lookback: 6, multiplier: 0.5, offsetDays: -14 },
      () => true
    );
    disposers.push(resource.subscribe(() => {}));
    await flush();
    const pending = resource.refresh();
    await resource.refresh();
    expect(refreshes).toBe(1);
    mutation.resolve(dashboard);
    await pending;
    expect(queries).toHaveLength(2);
    expect(queries[1]).toEqual({
      ...query,
      window: 'five-hour',
      lookback: 6,
      multiplier: 0.5,
      offsetDays: -14,
    });
    expect(resource.getSnapshot().refreshing).toBe(false);

    const failure = createPoolResource(
      {
        get: async () => dashboard,
        refresh: async () => {
          throw new Error('offline');
        },
      },
      query,
      () => true
    );
    disposers.push(failure.subscribe(() => {}));
    await flush();
    expect(await failure.refresh()).toBe(false);
    expect(failure.getSnapshot().refreshError).toBe(true);
    expect(failure.getSnapshot().data).toEqual(dashboard);
  });

  test('collects fresh quota every 60 seconds only while graphs are on screen', async () => {
    jest.useFakeTimers();
    const run = async (data: PoolDashboard, hidden = false) => {
      const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { visibilityState: hidden ? 'hidden' : 'visible' },
      });
      let refreshes = 0;
      const resource = createPoolResource(
        {
          get: async () => data,
          refresh: async () => {
            refreshes++;
            return data;
          },
        },
        query,
        () => true
      );
      const unsubscribe = resource.subscribe(() => {});
      try {
        for (let minute = 0; minute < 2; minute++) {
          // The page shows a countdown to this time; it moves forward a minute each cycle.
          const due = resource.getSnapshot().nextCollectAtMs;
          expect(due).toBe(Date.now() + 60_000);
          jest.advanceTimersByTime(60_000);
          for (let i = 0; i < 5; i++) await Promise.resolve();
          expect(resource.getSnapshot().nextCollectAtMs).toBe(due! + 60_000);
        }
        return refreshes;
      } finally {
        unsubscribe();
        if (previous) Object.defineProperty(globalThis, 'document', previous);
        else delete (globalThis as { document?: unknown }).document;
      }
    };
    try {
      expect(await run(dashboard)).toBe(2);
      expect(await run({ ...dashboard, pools: [] })).toBe(0);
      expect(await run(dashboard, true)).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('observes asynchronous collection completion within a second without another collection', async () => {
    jest.useFakeTimers();
    let busy = false;
    let reads = 0;
    let collections = 0;
    const resource = createPoolResource(
      {
        get: async () => {
          reads++;
          return { ...dashboard, refreshing: busy };
        },
        refresh: async () => {
          collections++;
          busy = true;
          return { ...dashboard, refreshing: true };
        },
      },
      query,
      () => true
    );
    const unsubscribe = resource.subscribe(() => {});
    try {
      await Promise.resolve();
      await resource.refresh();
      expect(resource.getSnapshot().data?.refreshing).toBe(true);
      expect(reads).toBe(2);
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(resource.getSnapshot().data?.refreshing).toBe(true);
      busy = false;
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(resource.getSnapshot().data?.refreshing).toBe(false);
      expect(reads).toBe(4);
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      expect(reads).toBe(4); // No fast polling after completion.
      expect(collections).toBe(1);
    } finally {
      unsubscribe();
      jest.useRealTimers();
    }
  });

  test('completion polls respect slow reads, failures, session invalidation and disposal', async () => {
    jest.useFakeTimers();
    let current = true;
    let reads = 0;
    const slow = deferred<PoolDashboard>();
    const resource = createPoolResource(
      {
        get: async () => {
          reads++;
          if (reads === 2) return slow.promise;
          if (reads === 3) throw new Error('offline');
          return { ...dashboard, refreshing: true };
        },
        refresh: async () => dashboard,
      },
      query,
      () => current
    );
    const unsubscribe = resource.subscribe(() => {});
    try {
      await Promise.resolve();
      jest.advanceTimersByTime(1000);
      jest.advanceTimersByTime(16000);
      expect(reads).toBe(2); // Neither normal nor fast polls abort a pending read.
      slow.resolve({ ...dashboard, refreshing: true });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(resource.getSnapshot().error).toBe(true);
      jest.advanceTimersByTime(5000);
      expect(reads).toBe(3); // On failure, back off to the normal polling interval.
      await resource.reload();
      current = false;
      jest.advanceTimersByTime(1000);
      expect(reads).toBe(4);
      current = true;
      await resource.reload();
      unsubscribe();
      jest.advanceTimersByTime(60000);
      expect(reads).toBe(5);
      expect(resource.getSnapshot().data).toBeNull();
    } finally {
      unsubscribe();
      jest.useRealTimers();
    }
  });

  test('poll failure keeps last data and reports it as failed, never a successful empty result', async () => {
    let fail = false;
    const resource = createPoolResource(
      {
        get: async () => {
          if (fail) throw new Error('offline');
          return dashboard;
        },
        refresh: async () => dashboard,
      },
      query,
      () => true
    );
    disposers.push(resource.subscribe(() => {}));
    await flush();
    fail = true;
    await resource.reload();
    expect(resource.getSnapshot().error).toBe(true);
    expect(resource.getSnapshot().data).toEqual(dashboard);
  });
});

describe('honest chart geometry', () => {
  test('the 5-hour and rate views show the span their data covers', () => {
    const DAY = 86_400_000;
    const view = { fromMs: 0, toMs: 10 * DAY, nowMs: 3 * DAY };
    // Remaining, weekly: the whole requested range.
    expect(viewRange({ ...view, window: 'weekly' }, 'remaining')).toEqual({
      fromMs: 0,
      toMs: 10 * DAY,
    });
    // 5-hour windows cycle within hours: a day either side of the snapshot.
    expect(viewRange({ ...view, window: 'five-hour' }, 'remaining')).toEqual({
      fromMs: 2 * DAY,
      toMs: 4 * DAY,
    });
    // Rates have no forecast: the range ends just after the snapshot.
    const rates = viewRange({ ...view, window: 'weekly' }, 'burn');
    expect(rates.fromMs).toBe(0);
    expect(rates.toMs).toBeGreaterThan(3 * DAY);
    expect(rates.toMs).toBeLessThan(3.5 * DAY);
    // Browsing an earlier range keeps the window inside that range.
    const past = viewRange(
      { fromMs: 0, toMs: DAY, nowMs: 3 * DAY, window: 'five-hour' },
      'remaining'
    );
    expect(past.fromMs).toBeGreaterThanOrEqual(0);
    expect(past.toMs).toBe(DAY);
    expect(past.fromMs).toBeLessThan(past.toMs);
  });
  test('lines crossing the range edge keep their neighbour outside, so they reach the edge', () => {
    const samples = [0, 100, 200, 300, 400].map((at) => ({
      point: point(at, at),
      projected: false,
    }));
    expect(inRange(samples, 150, 250).map(({ point }) => point.atMs)).toEqual([100, 200, 300]);
    expect(inRange(samples, 500, 600)).toEqual([]);
  });
  test('short ranges tick on whole hours', () => {
    const zone = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      const from = Date.UTC(2026, 9, 26, 12);
      const ticks = hourTicks(from, from + 2 * 86_400_000, 8);
      expect(ticks.length).toBeGreaterThanOrEqual(4);
      expect(ticks.length).toBeLessThanOrEqual(8);
      for (const at of ticks) expect(new Date(at).getMinutes()).toBe(0);
      expect(ticks[1] - ticks[0]).toBe(8 * 3_600_000);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
  test('day ticks land on local midnights, so labels name the day they mark', () => {
    // UTC midnight is 6 PM the previous day in Denver; ticks there were labelled a day early.
    const zone = process.env.TZ;
    process.env.TZ = 'America/Denver';
    try {
      const from = Date.UTC(2026, 9, 24);
      const ticks = dayTicks(from, from + 14 * 86_400_000, 8);
      expect(ticks.length).toBe(7);
      for (const at of ticks) {
        const day = new Date(at);
        expect([day.getHours(), day.getMinutes()]).toEqual([0, 0]);
      }
      expect(ticks[0]).toBe(from + 6 * 3_600_000); // Oct 24, 00:00 MDT
      expect(new Date(ticks[0]).getDate()).toBe(24);
      expect(ticks[1] - ticks[0]).toBe(2 * 86_400_000);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
  test('phone frame keeps the complete time range inside the available width', () => {
    const frame = fitChartFrame(320);
    const geometry = chartGeometry(
      chartSamples(pool.recorded, pool.projected, 'remaining'),
      'remaining',
      200,
      0,
      1000,
      frame
    );
    expect([geometry.x(0), geometry.x(1000)]).toEqual([40, 308]);
    expect(geometry.y(0)).toBe(frame.bottom);
    expect(geometry.y(200)).toBe(frame.top);
    expect(geometry.segments(true)[0]).toContain(
      `L${geometry.x(800)},${geometry.y(70)} L${geometry.x(800)},${geometry.y(170)}`
    );
  });
  test('shared frame preserves established plot coordinates', () => {
    const geometry = chartGeometry([], 'remaining', 200, 0, 1000);
    expect([geometry.x(0), geometry.x(1000), geometry.y(0), geometry.y(200)]).toEqual([
      64, 976, 254, 38,
    ]);
  });
  test('null observations split paths and preserve same-time reset jumps', () => {
    const geometry = chartGeometry(
      chartSamples(pool.recorded, pool.projected, 'remaining'),
      'remaining',
      200,
      0,
      1000
    );
    expect(geometry.segments(false)).toHaveLength(2);
    expect(geometry.segments(false).every((segment) => !segment.includes(' L'))).toBe(true);
    expect(geometry.segments(true)[0]).toContain(
      `L${geometry.x(800)},${geometry.y(70)} L${geometry.x(800)},${geometry.y(170)}`
    );
  });
  test('burn and drain never use projected samples and keep negative recorded rates', () => {
    for (const mode of ['burn', 'drain'] as const) {
      const samples = chartSamples(pool.recorded, pool.projected, mode);
      expect(samples).toHaveLength(3);
      expect(samples.some((sample) => sample.projected)).toBe(false);
      const geometry = chartGeometry(samples, mode, 200, 0, 1000);
      expect(geometry.segments(true)).toEqual([]);
      if (mode === 'drain') expect(geometry.min).toBe(-2);
    }
  });
  test('rate axes end on round values so their ticks read cleanly', () => {
    const rates = [point(0, 3.7), point(500, -1.3)].map((item) => ({
      point: {
        ...item,
        burnPointsPerHour: item.remainingPoints,
        drainPointsPerHour: item.remainingPoints,
      },
      projected: false,
    }));
    const geometry = chartGeometry(rates, 'drain', 200, 0, 1000);
    expect([geometry.min, geometry.max]).toEqual([-2, 4]);
    // A rate that never goes negative keeps a plain zero, not "-0", on its axis.
    const burn = chartGeometry(rates.slice(0, 1), 'burn', 200, 0, 1000);
    expect(Object.is(burn.min, 0)).toBe(true);
  });
  test('empty series produces no invented line', () => {
    const geometry = chartGeometry(
      chartSamples([point(500, null)], [], 'remaining'),
      'remaining',
      0,
      0,
      1000
    );
    expect(geometry.segments(false)).toEqual([]);
    expect(Number.isFinite(geometry.y(0))).toBe(true);
  });
});

describe('combined lanes chart model & rendering', () => {
  const sample = (at: number, value: number | null, projected = false) => ({
    point: point(at, value),
    projected,
  });

  test('adding a reset to Claude leaves Codex lane geometry byte-for-byte unchanged', async () => {
    await i18n.changeLanguage('en');
    const codex = {
      ...pool,
      provider: 'codex' as const,
      capacityPoints: 1000,
      remainingPoints: 600,
      recorded: [point(100, 700), point(500, 600)],
      projected: [point(500, 600), point(800, 520), point(800, 520), point(900, 490)],
      resets: [],
    };
    const claudeFlat = {
      ...pool,
      provider: 'claude' as const,
      capacityPoints: 8000,
      remainingPoints: 2000,
      recorded: [point(100, 2600), point(500, 2000)],
      projected: [point(500, 2000), point(800, 1500), point(800, 1500), point(900, 1300)],
      resets: [],
    };
    const claudeReset = {
      ...claudeFlat,
      projected: [point(500, 2000), point(800, 1500), point(800, 3500), point(900, 3300)],
      resets: [{ atMs: 800, gainPoints: 2000 }],
    };
    const totalOf = (c: typeof claudeFlat) => ({
      ...pool,
      capacityPoints: 9000,
      remainingPoints: 2600,
      recorded: [point(100, 3300), point(500, 2600)],
      projected: c.projected.map((p, i) =>
        point(p.atMs, p.remainingPoints! + codex.projected[i].remainingPoints!)
      ),
      resets: c.resets,
    });
    const sliceCodex = (html: string) => {
      const start = html.indexOf('data-series="codex"');
      return html.slice(start, html.indexOf('</g><line', start));
    };
    const before = renderToStaticMarkup(
      createElement(CombinedLanesChart, {
        lanes: [claudeFlat, codex],
        totalSeries: totalOf(claudeFlat),
        dashboard,
        mode: 'remaining',
      })
    );
    const after = renderToStaticMarkup(
      createElement(CombinedLanesChart, {
        lanes: [claudeReset, codex],
        totalSeries: totalOf(claudeReset),
        dashboard,
        mode: 'remaining',
      })
    );
    expect(sliceCodex(after)).toBe(sliceCodex(before));
    // Claude's reset draws one tick in Claude's lane and one top-edge tick on Total, none in Codex.
    expect(after.match(/data-reset-provider="claude"/g)).toHaveLength(1);
    expect(after.match(/data-reset-provider="codex"/g)).toBeNull();
    expect(after.match(/data-total-reset-tick="claude"/g)).toHaveLength(1);
    expect(after.match(/data-total-reset-tick="codex"/g)).toBeNull();
    // Codex uses its own capacity (1,000), while Total uses 9,000.
    expect(after).toContain('data-lane-capacity="1000"');
    expect(after).toContain('>1,000</text>');
    expect(after).toContain('>9,000</text>');
    expect(after).not.toContain('data-stack-band');
  });

  test('buildLaneStops collapses pre/post reset timestamps, preserves both sides, and steps 1 stop per timestamp', () => {
    // Astra's fixture: Codex resets 25 -> 75 (+50) at t=5 while Claude stays at 5; Total jumps 30 -> 80.
    const claude = {
      ...pool,
      provider: 'claude' as const,
      recorded: [point(0, 10)],
      projected: [point(0, 10), point(5, 5), point(5, 5), point(10, 0)],
      resets: [],
    };
    const codex = {
      ...pool,
      provider: 'codex' as const,
      recorded: [point(0, 30)],
      projected: [point(0, 30), point(5, 25), point(5, 75), point(10, 70)],
      resets: [{ atMs: 5, gainPoints: 50 }],
    };
    const total = [
      sample(0, 40, false),
      sample(0, 40, true),
      sample(5, 30, true),
      sample(5, 80, true),
      sample(10, 70, true),
    ];
    const stops = buildLaneStops({
      totalSamples: total,
      laneSamples: [
        [
          sample(0, 10, false),
          sample(0, 10, true),
          sample(5, 5, true),
          sample(5, 5, true),
          sample(10, 0, true),
        ],
        [
          sample(0, 30, false),
          sample(0, 30, true),
          sample(5, 25, true),
          sample(5, 75, true),
          sample(10, 70, true),
        ],
      ],
      lanes: [claude, codex],
      mode: 'remaining',
      labelOf: (lane) => (lane.provider === 'claude' ? 'Claude' : 'Codex'),
    });
    // Redundant (0, true) collapses into (0, false), and (5, true) pre/post collapses into one reset stop.
    expect(stops.map((s) => [s.atMs, s.projected])).toEqual([
      [0, false],
      [5, true],
      [10, true],
    ]);
    expect(stops[1].totalBefore).toBe(30);
    expect(stops[1].totalAfter).toBe(80);
    expect(stops[1].lanes[0]).toEqual({ before: 5, after: 5, present: true });
    expect(stops[1].lanes[1]).toEqual({ before: 25, after: 75, present: true });
    expect(stops[1].resets).toEqual([
      {
        laneIndex: 1,
        provider: 'codex',
        label: 'Codex',
        atMs: 5,
        gainPoints: 50,
        before: 25,
        after: 75,
      },
    ]);
    expect(nextResetStopIndex(stops, 0, 1)).toBe(1);
    expect(nextResetStopIndex(stops, 1, 1)).toBeNull();
    // 1D X scrub magnetically snaps to the reset stop within 12px.
    expect(selectStopAtX(stops, 58, (t) => t * 10, 12)).toBe(1);
  });

  test('unknown total breaks only the Total path while healthy provider lanes keep drawing', async () => {
    await i18n.changeLanguage('en');
    const a = {
      ...pool,
      provider: 'claude' as const,
      recorded: [point(100, 70), point(300, 50), point(500, 20)],
      projected: [],
      resets: [],
    };
    const b = {
      ...pool,
      provider: 'codex' as const,
      recorded: [point(100, 30), point(300, null), point(500, 30)],
      projected: [],
      resets: [],
    };
    const total = {
      ...pool,
      capacityPoints: 400,
      recorded: [point(100, 100), point(300, null), point(500, 50)],
      projected: [],
      resets: [],
    };
    const markup = renderToStaticMarkup(
      createElement(CombinedLanesChart, {
        lanes: [a, b],
        totalSeries: total,
        dashboard,
        mode: 'remaining',
      })
    );
    const totalStart = markup.indexOf('data-series="total"');
    const claudeStart = markup.indexOf('data-series="claude"');
    const totalSvg = markup.slice(totalStart, claudeStart);
    const claudeSvg = markup.slice(claudeStart, markup.indexOf('data-series="codex"'));
    // Total splits into 2 runs around the null at 300; Claude stays one continuous polyline.
    expect(totalSvg.match(/stroke="var\(--text-primary\)"/g)).toHaveLength(2);
    expect(claudeSvg.match(/stroke="var\(--pool-accent\)"/g)).toHaveLength(1);
  });

  test('signed drain always includes a zero axis tick and renders Total and lanes across zero', async () => {
    await i18n.changeLanguage('en');
    expect(axisTicks(-8, 12)).toEqual([-8, 0, 12]);
    expect(axisTicks(0, 10)).toEqual([0, 5, 10]);
    expect(axisTicks(0, 0)).toEqual([0]);
    const drainPt = (at: number, drain: number): PoolPoint => ({
      atMs: at,
      remainingPoints: 100,
      burnPointsPerHour: 2,
      drainPointsPerHour: drain,
    });
    const a = {
      ...pool,
      provider: 'claude' as const,
      recorded: [drainPt(100, -8), drainPt(500, 6)],
      projected: [],
      resets: [],
    };
    const b = {
      ...pool,
      provider: 'codex' as const,
      recorded: [drainPt(100, 3), drainPt(500, 2)],
      projected: [],
      resets: [],
    };
    const total = {
      ...pool,
      recorded: [drainPt(100, -5), drainPt(500, 8)],
      projected: [],
      resets: [],
    };
    const markup = renderToStaticMarkup(
      createElement(CombinedLanesChart, {
        lanes: [a, b],
        totalSeries: total,
        dashboard,
        mode: 'drain',
      })
    );
    expect(markup).not.toContain('stroke-dasharray');
    expect(markup).toContain('>0</text>');
    expect(markup).not.toContain('data-reset-provider');
  });

  test('simultaneous resets offset on Total and right-edge labels flip left without clipping', () => {
    const a = {
      ...pool,
      provider: 'claude' as const,
      resets: [{ atMs: 800, gainPoints: 2000 }],
    };
    const b = {
      ...pool,
      provider: 'codex' as const,
      resets: [{ atMs: 800, gainPoints: 500 }],
    };
    const ticks = placeTotalResetTicks(
      [a, b],
      0,
      1000,
      (t) => t,
      (l) => l.provider
    );
    expect(ticks).toHaveLength(2);
    expect(ticks[0].x).not.toBe(ticks[1].x);
    const placed = placeLaneResets(
      [{ atMs: 990, gainPoints: 480 }],
      0,
      1000,
      (t) => t,
      1000,
      'en',
      true
    );
    expect(placed[0].anchor).toBe('end');
    expect(placed[0].labelX).toBeLessThan(990);
    const next = findNextReset([a, b], 500, 1000, (l) =>
      l.provider === 'claude' ? 'Claude' : 'Codex'
    );
    expect(next).toEqual({
      atMs: 800,
      items: [
        { provider: 'claude', label: 'Claude', gainPoints: 2000 },
        { provider: 'codex', label: 'Codex', gainPoints: 500 },
      ],
    });
  });

  test('a history-only lane draws its history with no forecast stroke or reset ticks', async () => {
    await i18n.changeLanguage('en');
    const live = {
      ...pool,
      provider: 'claude' as const,
      recorded: [point(100, 70), point(500, 60)],
      projected: [point(500, 60), point(900, 40)],
      resets: [{ atMs: 800, gainPoints: 100 }],
    };
    const dormant = {
      ...pool,
      provider: 'antigravity' as const,
      historyOnly: true as const,
      recorded: [point(100, 30), point(500, 0)],
      projected: [point(500, 0), point(900, 0)],
      resets: [{ atMs: 800, gainPoints: 50 }],
    };
    const total = {
      ...pool,
      capacityPoints: 400,
      recorded: [point(100, 100), point(500, 60)],
      projected: [point(500, 60), point(900, 40)],
      resets: [{ atMs: 800, gainPoints: 100 }],
    };
    const markup = renderToStaticMarkup(
      createElement(CombinedLanesChart, {
        lanes: [live, dormant],
        totalSeries: total,
        dashboard,
        mode: 'remaining',
      })
    );
    const geminiStart = markup.indexOf('data-series="antigravity"');
    const geminiEnd = markup.indexOf('<line x1=', geminiStart);
    expect(markup.slice(geminiStart, geminiEnd)).not.toContain('stroke-dasharray');
    expect(markup).not.toContain('data-reset-provider="antigravity"');
    expect(markup).toContain('History only');
  });

  test('a selected forecast moment reads only live lanes, never a history-only one', async () => {
    await i18n.changeLanguage('en');
    const live = {
      ...pool,
      provider: 'claude' as const,
      recorded: [],
      projected: [point(500, 60)],
      resets: [],
    };
    const dormant = {
      ...pool,
      provider: 'antigravity' as const,
      historyOnly: true as const,
      recorded: [],
      projected: [point(500, 0)],
      resets: [],
    };
    const total = {
      ...pool,
      capacityPoints: 400,
      recorded: [],
      projected: [point(500, 60)],
      resets: [],
    };
    const markup = renderToStaticMarkup(
      createElement(CombinedLanesChart, {
        lanes: [live, dormant],
        totalSeries: total,
        dashboard,
        mode: 'remaining',
      })
    );
    const readout = markup.slice(markup.indexOf('aria-live'));
    expect(readout).toContain('Total: 60\u00a0points');
    expect(readout).toContain('Claude: 60\u00a0points');
    expect(readout).not.toContain('Gemini');
    // Crosshair has dots on Total + Claude only (never Gemini's dormant alignment zero).
    const crosshair = markup.slice(markup.indexOf('data-crosshair="true"'));
    expect(crosshair.slice(0, crosshair.indexOf('</g>')).match(/<circle/g)).toHaveLength(2);
  });

  test('collapses past 3 provider lanes while preserving next reset across all providers', async () => {
    await i18n.changeLanguage('en');
    const make = (provider: string, resetAt?: number) => ({
      ...pool,
      provider,
      displayName: provider,
      recorded: [point(100, 50), point(500, 40)],
      projected: [point(500, 40), point(900, 30)],
      resets: resetAt ? [{ atMs: resetAt, gainPoints: 80 }] : [],
    });
    const lanes = [make('claude'), make('codex'), make('antigravity'), make('orbit-ai', 700)];
    const markup = renderToStaticMarkup(
      createElement(CombinedLanesChart, {
        lanes,
        totalSeries: { ...pool, capacityPoints: 800, resets: [{ atMs: 700, gainPoints: 80 }] },
        dashboard,
        mode: 'remaining',
      })
    );
    expect(markup).toContain('Show all 4 providers');
    expect(markup).toContain('data-series="claude"');
    expect(markup).toContain('data-series="codex"');
    expect(markup).toContain('data-series="antigravity"');
    expect(markup).not.toContain('data-series="orbit-ai"');
    // Next reset and Total top-edge tick still include the collapsed 4th provider.
    expect(markup).toContain('orbit-ai +80');
    expect(markup).toContain('data-total-reset-tick="orbit-ai"');
  });
  test('long rosters get search, sort and a low count; short ones stay plain', async () => {
    await i18n.changeLanguage('en');
    const account = pool.accounts[0];
    const roster = (count: number) => ({
      ...pool,
      accounts: Array.from({ length: count }, (_, index) => ({
        ...account,
        id: `opaque-${index}`,
        label: `Roster account ${index + 1}`,
        windows: account.windows.map((limit) => ({
          ...limit,
          remainingPercent: index === 0 ? 12 : 80,
        })),
      })),
    });
    const render = (count: number) =>
      renderToStaticMarkup(
        createElement(PoolCard, {
          pool: roster(count),
          dashboard,
          mode: 'remaining',
          reveal: false,
        })
      );
    const long = render(10);
    expect(long).toContain('type="search"');
    // The visible label is the field's accessible name, so it stays once text is typed.
    expect(long).toMatch(/<label[^>]*><span[^>]*>Search accounts<\/span><input type="search"/);
    expect(long).toContain('Lowest limit remaining first');
    // The sort pill carries a visible "Sort" prefix ahead of the select.
    expect(long).toMatch(/<label[^>]*><span[^>]*>Sort<\/span><select/);
    // The low chip uses one stable noun phrase across off and on states ("Limit below 20% (N)").
    expect(long).toMatch(/<button[^>]*aria-pressed="false"[^>]*>[\s\S]*?Limit below 20% \(1\)/);
    expect(long).toContain('data-large="true"');
    const short = render(3);
    expect(short).not.toContain('type="search"');
    expect(short).not.toContain('Lowest limit remaining first');
  });
  test('rosters default to name order; lowest-first puts accounts without data first', async () => {
    await i18n.changeLanguage('en');
    const account = pool.accounts[0];
    const named = (id: string, label: string, percent: number | null) => ({
      ...account,
      id,
      label,
      remainingPercent: percent,
      windows: account.windows.map((limit) => ({ ...limit, remainingPercent: percent })),
    });
    const accounts = [
      named('c', 'Account 10', 50),
      named('a', 'Account 2', 90),
      named('d', 'Account 3', null),
      named('b', 'Account 1', 5),
    ];
    const label = (a: (typeof accounts)[number]) => a.label;
    expect(sortAccounts(accounts, 'name', label, 'en').map(label)).toEqual([
      'Account 1',
      'Account 2',
      'Account 3',
      'Account 10',
    ]);
    expect(sortAccounts(accounts, 'lowest', label, 'en').map(label)).toEqual([
      'Account 3',
      'Account 1',
      'Account 10',
      'Account 2',
    ]);
    const roster = Array.from({ length: 10 }, (_, index) =>
      named(`id-${9 - index}`, `Roster ${String.fromCharCode(74 - index)}`, 80)
    );
    const markup = renderToStaticMarkup(
      createElement(PoolCard, {
        pool: { ...pool, accounts: roster },
        dashboard,
        mode: 'remaining',
        reveal: false,
      })
    );
    expect(markup).toContain('Name A–Z');
    expect(markup).not.toContain('Default order');
    expect(markup.indexOf('Roster A')).toBeLessThan(markup.indexOf('Roster B'));
    expect(markup.indexOf('Roster B')).toBeLessThan(markup.indexOf('Roster J'));
  });
  test('every view groups the one measured fact as Now beside the Forecast', async () => {
    await i18n.changeLanguage('en');
    const card = (shown: QuotaPool, mode: 'remaining' | 'burn') =>
      renderToStaticMarkup(
        createElement(PoolCard, { pool: shown, dashboard, mode, reveal: false })
      );
    // Remaining: the burn rate is the measured fact; the headline is the balance.
    expect(card(pool, 'remaining')).toMatch(/<p>Now<\/p><dl><div><dt>Burn rate \(3h\)<\/dt>/);
    // Rate views: the headline is the rate, so the balance is the one fact Now holds, label over value.
    expect(card(pool, 'burn')).toMatch(
      /<p[^>]*>Now<\/p><dl[^>]*><div><dt>Weekly remaining<\/dt><dd>73 <small>of 200 points<\/small><\/dd><\/div><\/dl>/
    );
    // A withheld forecast with no burn rate has nothing measured to add, so Now is left out.
    expect(card({ ...pool, burnPointsPerHour: null }, 'remaining')).not.toContain('<p>Now</p>');
  });
  test('the latest reading names its value unless the card already shows it', async () => {
    await i18n.changeLanguage('en');
    const readout = (shown: QuotaPool) =>
      renderToStaticMarkup(
        createElement(PoolChart, { pool: shown, dashboard, mode: 'remaining' })
      ).match(/id="[^"]*-readout"[^>]*>([^<]*)</)?.[1] ?? '';
    // The card's big number is the latest value, so the readout gives only its moment.
    expect(readout(pool)).toMatch(/^Latest reading · /);
    expect(readout(pool)).not.toContain('73');
    // A withheld total leaves the card without a number, so the readout keeps the value.
    expect(readout({ ...pool, remainingPoints: null })).toContain('73');
  });
  test('combined lanes readout names the latest moment and places a crosshair dot in each lane', async () => {
    await i18n.changeLanguage('en');
    const a = {
      ...pool,
      provider: 'claude' as const,
      recorded: [point(500, 20)],
      projected: [],
      resets: [],
    };
    const b = {
      ...pool,
      provider: 'codex' as const,
      recorded: [point(500, 30)],
      projected: [],
      resets: [],
    };
    const markup = renderToStaticMarkup(
      createElement(CombinedLanesChart, { lanes: [a, b], dashboard, mode: 'remaining' })
    );
    expect(markup).toContain('Latest reading · ');
    expect(markup).toContain('20 / 200');
    expect(markup).toContain('30 / 200');
    const crosshair = markup.slice(markup.indexOf('data-crosshair="true"'));
    expect(crosshair.slice(0, crosshair.indexOf('</g>')).match(/<circle/g)).toHaveLength(2);
  });
});

describe('pool presentation', () => {
  test('exposes charts before account rows while retaining balances and the quota window', async () => {
    await i18n.changeLanguage('en');
    const markup = renderToStaticMarkup(
      createElement(PoolCard, {
        pool: { ...pool, remainingPoints: 0, forecastState: 'ready' },
        dashboard,
        mode: 'remaining',
        reveal: false,
      })
    );
    expect(markup).toContain('Weekly quota remaining');
    expect(markup).toContain('Forecast ready');
    expect(markup).not.toContain('>Ready<');
    const accounts = markup.slice(markup.search(/<section[^>]*aria-labelledby="[^"]+-accounts"/));
    expect(accounts).toContain('Claude account 1');
    // Every limit percentage carries one decimal, so a column of them lines up.
    expect(accounts).toContain('73.0%');
    expect(markup.indexOf('<svg')).toBeLessThan(markup.indexOf('Claude account 1'));
    expect(markup).not.toMatch(/<details[^>]*forecast/);
    expect(markup).not.toMatch(/<details[^>]*\bopen[\s=>]/);
  });

  test('combined plot keeps source traces and unknown gaps separate in independent lanes without summing', async () => {
    await i18n.changeLanguage('en');
    const alpha = { ...pool, instanceId: 'alpha', sourceLabel: 'Alpha' };
    const beta = {
      ...pool,
      instanceId: 'beta',
      sourceLabel: 'Beta',
      capacityPoints: 500,
      recorded: [point(100, 400), point(500, 390)],
      projected: [],
      forecastState: 'stale' as const,
    };
    const markup = renderToStaticMarkup(
      createElement(CombinedLanesChart, {
        lanes: [alpha, beta],
        dashboard,
        mode: 'remaining',
      })
    );
    expect(markup).not.toContain('data-series="total"');
    expect(markup).toContain('data-series="alpha"');
    expect(markup).toContain('data-series="beta"');
    expect(markup).toContain('Claude · Alpha');
    expect(markup).toContain('Claude · Beta');
    expect(markup).toContain('Stale');
    expect(markup).toContain('>500</text>');
    expect(markup).not.toContain('>700</text>');
    expect(markup).not.toContain('private@example.test');
    const a = chartSamples(alpha.recorded, [], 'remaining');
    const b = chartSamples(beta.recorded, [], 'remaining');
    const geometry = chartGeometry([...a, ...b], 'remaining', 500, 0, 1000);
    expect(geometry.segments(false, a)).toHaveLength(2);
    expect(geometry.segments(false, b)).toHaveLength(1);
    expect(geometry.segments(false, a).every((path) => !path.includes(' L'))).toBe(true);
    expect(geometry.segments(false, b)[0]).toContain(' L');
  });

  test('minimized charts preserve scale and data; combined rate charts omit forecasts', () => {
    const normal = fitChartFrame(1000);
    const small = fitChartFrame(1000, false, true);
    expect(small.height).toBeLessThan(normal.height);
    const samples = chartSamples(pool.recorded, pool.projected, 'drain');
    const full = chartGeometry(samples, 'drain', 200, 0, 1000, normal);
    const compact = chartGeometry(samples, 'drain', 200, 0, 1000, small);
    expect([compact.min, compact.max]).toEqual([full.min, full.max]);
    const markup = renderToStaticMarkup(
      createElement(CombinedLanesChart, {
        lanes: [pool, { ...pool, provider: 'codex' }],
        totalSeries: { ...pool, capacityPoints: 400 },
        dashboard,
        mode: 'drain',
        minimized: true,
      })
    );
    expect(markup).not.toContain('stroke-dasharray');
    expect(markup).toContain('viewBox="0 0 1000 160"');
    expect(markup).toContain('points/h');
    // Minimized hides lanes and restores provider keys in the legend.
    expect(markup).toContain('data-series="total"');
    expect(markup).not.toContain('data-series="claude"');
    expect(markup).toContain('Claude');
    expect(markup).toContain('Codex');
  });

  test('dense forecast dots cannot fill the dashed line, while isolated forecasts remain visible', () => {
    const dense = renderToStaticMarkup(
      createElement(CombinedLanesChart, { lanes: [pool], dashboard, mode: 'remaining' })
    );
    expect(dense).toContain('stroke-dasharray="7 5"');
    expect(dense).not.toContain('opacity="0.6"');
    const isolated = renderToStaticMarkup(
      createElement(CombinedLanesChart, {
        lanes: [{ ...pool, projected: [point(800, 70)] }],
        dashboard,
        mode: 'remaining',
      })
    );
    expect(isolated).toContain('opacity="0.6"');
  });

  test('hides reset markers that replenish no balance', () => {
    const markup = renderToStaticMarkup(
      createElement(PoolChart, {
        pool: { ...pool, resets: [{ atMs: 800, gainPoints: 0 }] },
        dashboard,
        mode: 'remaining',
      })
    );
    expect(markup).not.toContain('Reset:');
    expect(markup).not.toContain('>+0<');
  });

  test('an upper reset label drops its leader where it would cross a lower label', () => {
    const chart = (second: number) =>
      renderToStaticMarkup(
        createElement(PoolChart, {
          pool: {
            ...pool,
            resets: [
              { atMs: 800, gainPoints: 100 },
              { atMs: second, gainPoints: 100 },
            ],
          },
          dashboard,
          mode: 'remaining',
        })
      );
    // The leader runs from the upper lane (34px over the frame) down to the frame's top.
    const leader = /<line x1="[\d.]+" x2="[\d.]+" y1="28" y2="56"><\/line>/;
    // Two resets a few pixels apart: the first label rises, the second sits under its leader.
    const close = chart(805);
    expect(close.match(/>\+100<\/text>/g)).toHaveLength(2);
    expect(close).toContain('y="22" text-anchor="middle">+100');
    expect(close).toContain('y="46" text-anchor="middle">+100');
    expect(close).not.toMatch(leader);
    // Far enough apart that the lower label clears the leader, which then stays.
    expect(chart(860)).toMatch(leader);
  });

  test('a wide reset cell names itself and measures its held line against the column', async () => {
    await i18n.changeLanguage('en');
    const day = 86_400_000;
    const later = Date.now() + day;
    const kinds = ['session', 'weekly', 'fable'] as const;
    const holder = {
      ...pool.accounts[0],
      resets: {
        available: 3,
        usable: 2,
        blocker: null,
        kinds: [...kinds],
        expiries: kinds.map((_, index) => later + index * day),
        nextExpiryAtMs: later,
        observedAtMs: 500,
      },
    };
    const markup = renderToStaticMarkup(
      createElement(PoolCard, {
        pool: { ...pool, accounts: [holder] },
        dashboard,
        mode: 'remaining',
        reveal: false,
      })
    );
    // The column heading is hidden from screen readers, so the cell leads with its own label. The
    // held line starts with the kinds; a hidden copy lets the browser swap in "3 held" when they
    // don't fit the column (the capture checks that in English and Russian).
    expect(markup).toMatch(
      /<span>Manual resets <\/span><span data-usable="true">2 usable<\/span><small>(?:(?!<\/small>).)*1 5-hour(?:(?!<\/small>).)*<\/small><span aria-hidden="true">(?:(?!<\/span><\/span>).)*1 Fable/
    );
  });

  test('uses server capacity and missing predictions without exposing hidden emails', async () => {
    await i18n.changeLanguage('en');
    const markup = renderToStaticMarkup(
      createElement(PoolCard, { pool, dashboard, mode: 'remaining', reveal: false })
    );
    expect(markup).toContain('of 200 points');
    expect(markup).toContain('Not reported');
    expect(markup).toContain('Total and forecast unavailable');
    expect(markup).toContain('Claude account 1');
    expect(markup).toContain('Max 20x · 2,000 points');
    // Every reported limit is listed under its account; low ones are flagged.
    expect(markup).toContain('aria-label="Limits"');
    expect(markup).toMatch(
      /<li data-limit-id="five-hour" data-low="true"[^>]*><span>5-hour remaining<\/span>[\s\S]*?<strong><span><span><span aria-hidden="true">[\s\S]*?<\/span><span>Low<\/span><\/span>[\s\S]*?<span>12.0%<\/span>/
    );
    // The visible word is the accessible text: no second, hidden "Low" beside it.
    expect(markup.match(/>Low</g)).toHaveLength(1);
    expect(markup).toMatch(
      /<li data-limit-id="seven-day-opus" data-low="false"[^>]*><span>[^<]*Opus[^<]*<\/span>[\s\S]*?64.0%/
    );
    // Accounts start collapsed (numbers only); one control expands the whole section.
    expect(markup).toMatch(
      /<button type="button"[^>]*aria-expanded="false"[^>]*>Expand all<\/button>/
    );
    expect(markup).not.toMatch(/<details[^>]* open=""/);
    expect(markup).not.toContain('private@example.test');
    // The chart itself is inspected by pointer or arrow keys; no separate slider.
    expect(markup).not.toContain('type="range"');
    const chart = markup.match(/<svg[^>]*role="img"[^>]*>/)?.[0] ?? '';
    expect(chart).toContain('tabindex="0"');
    expect(chart).toMatch(/aria-describedby="[^"]*-readout"/);
    expect(markup).toContain('stroke-dasharray="7 5"');
    // The summary is the row's toggle, so it carries its expanded state.
    expect(markup).toContain('<summary aria-expanded="false">');
    const revealed = renderToStaticMarkup(
      createElement(PoolCard, { pool, dashboard, mode: 'remaining', reveal: true })
    );
    expect(revealed).toContain('private@example.test');
  });
  test('a combined total withheld for partial data says why, as the provider cards do', async () => {
    await i18n.changeLanguage('en');
    const series = { ...pool, forecastState: 'partial' as const, remainingPoints: null };
    const markup = renderToStaticMarkup(
      createElement(CombinedPoolCard, {
        pools: [pool],
        dashboard: {
          ...dashboard,
          combined: {
            all: { series, layers: [{ ...series, provider: 'claude' }], unavailableReason: null },
          },
        },
        provider: 'all',
        mode: 'remaining',
        savedData: false,
        onRefresh: () => {},
      })
    );
    // The value slot says the total is withheld, so it never passes for a value.
    expect(markup).toContain('<strong><span>Withheld</span></strong>');
    expect(markup).toContain('<p>Weekly quota remaining</p>');
    expect(markup).toContain('some eligible accounts have no current quota data');
    // The notice offers the same next step as the provider cards.
    expect(markup).toMatch(/quota data\.<\/span><button type="button">Refresh now<\/button><\/p>/);
  });
  test('an ambiguous total omits the Total plot, shows independent lanes, and keeps its reason with no dropdown', async () => {
    await i18n.changeLanguage('en');
    const markup = renderToStaticMarkup(
      createElement(CombinedPoolCard, {
        pools: [
          { ...pool, instanceId: 'alpha', sourceLabel: 'Alpha' },
          { ...pool, instanceId: 'beta', sourceLabel: 'Beta' },
        ],
        dashboard: {
          ...dashboard,
          combined: { all: { series: null, unavailableReason: 'ambiguous-sources' } },
        },
        provider: 'all',
        mode: 'remaining',
        savedData: false,
      })
    );
    expect(markup).toContain('role="img"');
    expect(markup).toContain('may share accounts');
    expect(markup).toContain('<strong><span>Not summed</span></strong>');
    expect(markup).not.toContain('<select');
    expect(markup).not.toContain('data-series="total"');
    expect(markup).toContain('Claude · Alpha');
    expect(markup).toContain('Claude · Beta');
    expect(markup).toMatch(/may share accounts[^<]*<\/p>/);
  });
  test('the limit that feeds the pool is marked, not repeated as another column', async () => {
    await i18n.changeLanguage('en');
    const weekly = {
      id: 'seven-day',
      labelKey: 'claude_quota.seven_day',
      remainingPercent: 73,
      resetAtMs: 900,
    };
    const markup = renderToStaticMarkup(
      createElement(PoolCard, {
        pool: {
          ...pool,
          accounts: [{ ...pool.accounts[0], windows: [...pool.accounts[0].windows, weekly] }],
        },
        dashboard,
        mode: 'remaining',
        reveal: false,
      })
    );
    expect(markup).toContain(
      '<span data-counted="true">Weekly remaining<small>counts toward total</small></span>'
    );
    // The column heading, the row's own limit and the phone note ("Weekly remaining counts toward total")
    // name it once each; the section heading doesn't repeat it and the table has no duplicate balance column.
    expect(markup.match(/Weekly remaining/g)).toHaveLength(3);
    expect(markup).toContain('Weekly remaining counts toward total');
  });
  test('a low balance is marked on the row as well as on its limit', async () => {
    await i18n.changeLanguage('en');
    const markup = renderToStaticMarkup(
      createElement(PoolCard, {
        pool: { ...pool, accounts: [{ ...pool.accounts[0], remainingPercent: 12 }] },
        dashboard,
        mode: 'remaining',
        reveal: false,
      })
    );
    expect(markup).toMatch(/<strong data-low="true">.*?<span>Low<\/span>.*?12.0%/);
  });
  test('accounts without a 5-hour limit say so in their rows and are not counted as missing', async () => {
    await i18n.changeLanguage('en');
    const ultra = {
      ...pool.accounts[0],
      id: 'opaque-2',
      status: 'no-limit' as const,
      noFiveHourLimit: true,
    };
    const markup = renderToStaticMarkup(
      createElement(PoolCard, {
        pool: {
          ...pool,
          accounts: [pool.accounts[0], ultra],
          accountCount: 2,
          eligibleCount: 1,
          loadedCount: 1,
        },
        dashboard: { ...dashboard, window: 'five-hour' },
        mode: 'remaining',
        reveal: false,
      })
    );
    // The row carries it (G11): no pool fact repeats it, and the account is not "missing".
    expect(markup).toContain('<span>No 5-hour limit</span>');
    expect(markup).not.toContain('With a 5-hour limit');
    expect(markup).not.toContain('Reporting');
    expect(markup).not.toContain('loaded ·');
  });
  test('a pool with no 5-hour limit at all says so, without a points scale or an empty chart', async () => {
    await i18n.changeLanguage('en');
    for (const mode of ['remaining', 'burn', 'drain'] as const) {
      const weeklyOnly = {
        ...pool.accounts[0],
        status: 'no-limit' as const,
        noFiveHourLimit: true,
        remainingPercent: null,
      };
      const markup = renderToStaticMarkup(
        createElement(PoolCard, {
          pool: {
            ...pool,
            accounts: [weeklyOnly],
            accountCount: 1,
            eligibleCount: 0,
            loadedCount: 0,
            capacityPoints: 0,
            remainingPoints: 0,
            forecastState: 'no-limit',
            recorded: [],
            projected: [],
          },
          dashboard: { ...dashboard, window: 'five-hour' },
          mode,
          reveal: false,
        })
      );
      expect(markup).toContain('No 5-hour limit');
      expect(markup).not.toContain('of 0 points');
      expect(markup).not.toContain('No observations in this range');
      // No chart, so no control for one.
      expect(markup).not.toContain('Minimize graph');
    }
  });
  test('a partial pool counts the accounts missing data and offers to show them; the combined card offers one refresh', async () => {
    await i18n.changeLanguage('en');
    const missing = {
      ...pool.accounts[0],
      id: 'opaque-9',
      identifier: 'gra•••er@ex•••.test',
      status: 'error' as const,
      remainingPercent: null,
    };
    const partial = {
      ...pool,
      forecastState: 'partial' as const,
      remainingPoints: null,
      accounts: [pool.accounts[0], missing],
    };
    const markup = renderToStaticMarkup(
      createElement(PoolCard, { pool: partial, dashboard, mode: 'remaining', reveal: false })
    );
    // The notice counts instead of listing masked names, and its action filters the list to them.
    expect(markup).toContain(
      'No current quota data from 1 of 2 accounts, so the total is withheld.'
    );
    expect(markup).toMatch(/<button[^>]*>Show affected accounts<\/button>/);
    expect(markup.match(/<p role="status"[^>]*>[\s\S]*?<\/p>/)?.[0]).not.toContain('gra•••er');
    // The page has one "Refresh now", on the combined card; pool notices only name the cause.
    expect(markup).not.toContain('Refresh now');
    // The forecast is withheld: its dash-only stats are not shown, Next reset stays.
    expect(markup).not.toContain('Pool empty');
    expect(markup).toContain('Next reset');
    const combined = renderToStaticMarkup(
      createElement(CombinedPoolCard, {
        pools: [partial],
        dashboard: {
          ...dashboard,
          combined: {
            all: {
              series: partial,
              layers: [{ ...partial, provider: 'claude' }],
              unavailableReason: null,
            },
          },
        },
        provider: 'all',
        mode: 'remaining',
        savedData: false,
        onRefresh: () => {},
      })
    );
    expect(combined).toContain(
      'No current quota data from 1 of 2 accounts, so the total is withheld.'
    );
    expect(combined.match(/Refresh now/g)).toHaveLength(1);
  });
  test('an estimated combined total still says it uses last readings, with Refresh now', async () => {
    await i18n.changeLanguage('en');
    const stale = { ...pool.accounts[0], id: 'opaque-9', status: 'stale' as const };
    const estimated: QuotaPool = {
      ...pool,
      forecastState: 'stale',
      remainingPoints: 150,
      estimatedCount: 1,
      accounts: [stale, ...pool.accounts.slice(1)],
    };
    const combined = renderToStaticMarkup(
      createElement(CombinedPoolCard, {
        pools: [estimated],
        dashboard: {
          ...dashboard,
          combined: {
            all: {
              series: estimated,
              layers: [{ ...estimated, provider: 'claude' }],
              unavailableReason: null,
            },
          },
        },
        provider: 'all',
        mode: 'remaining',
        savedData: false,
        onRefresh: () => {},
      })
    );
    expect(combined).toContain(
      'No recent reading from 1 of 1 accounts, so the total uses their last readings.'
    );
    expect(combined.match(/Refresh now/g)).toHaveLength(1);
  });
  test('stale accounts are counted as stale, not as missing', async () => {
    await i18n.changeLanguage('en');
    const stale = { ...pool.accounts[0], id: 'opaque-8', status: 'stale' as const };
    const markup = renderToStaticMarkup(
      createElement(PoolCard, {
        pool: {
          ...pool,
          forecastState: 'stale',
          accounts: [pool.accounts[0], stale],
          accountCount: 2,
          loadedCount: 1,
          eligibleCount: 2,
        },
        dashboard,
        mode: 'remaining',
        reveal: false,
      })
    );
    expect(markup).toMatch(/>Current<\/span> <b[^>]*>1<\/b>/);
    expect(markup).toMatch(/>Stale<\/span> <b[^>]*>1<\/b>/);
  });
  test('a forecast beyond the range says when the range ends', async () => {
    await i18n.changeLanguage('en');
    const markup = renderToStaticMarkup(
      createElement(PoolCard, {
        pool: { ...pool, forecastState: 'ready', poolEmptyAtMs: null },
        dashboard,
        mode: 'remaining',
        reveal: false,
      })
    );
    expect(markup).toMatch(/<dt>Pool empty<\/dt><dd>Not before [^<]+<\/dd>/);
  });
  test('rate views date the remaining-quota forecast like the Remaining view', async () => {
    await i18n.changeLanguage('en');
    // A ten-day range whose snapshot sits mid-range: rate charts end near the snapshot.
    const wide = {
      ...dashboard,
      fromMs: dashboard.nowMs - 5 * 86_400_000,
      toMs: dashboard.nowMs + 5 * 86_400_000,
    };
    const emptyFact = (mode: 'remaining' | 'drain') =>
      renderToStaticMarkup(
        createElement(PoolCard, {
          pool: { ...pool, forecastState: 'ready', poolEmptyAtMs: null },
          dashboard: wide,
          mode,
          reveal: false,
        })
      ).match(/<dt>Pool empty<\/dt><dd>([^<]+)<\/dd>/)?.[1];
    expect(emptyFact('remaining')).toBeDefined();
    expect(emptyFact('drain')).toBe(emptyFact('remaining'));
  });
  test('long rosters show the first page and offer the rest', async () => {
    await i18n.changeLanguage('en');
    const accounts = Array.from({ length: 30 }, (_, index) => ({
      ...pool.accounts[0],
      id: `opaque-${index}`,
      identifier: `acc${index}`,
    }));
    const markup = renderToStaticMarkup(
      createElement(PoolCard, {
        pool: { ...pool, accounts, accountCount: 30, loadedCount: 30, eligibleCount: 30 },
        dashboard,
        mode: 'remaining',
        reveal: false,
      })
    );
    expect(markup.match(/<details/g)).toHaveLength(25);
    expect(markup).toContain('Show 5 more');
    expect(markup).toContain('25 of 30 shown');
  });
  test('a limit an account does not have keeps its column and says why', async () => {
    await i18n.changeLanguage('en');
    const ultra = {
      ...pool.accounts[0],
      id: 'opaque-2',
      noFiveHourLimit: true,
      windows: pool.accounts[0].windows.filter((limit) => limit.id !== 'five-hour'),
    };
    const markup = renderToStaticMarkup(
      createElement(PoolCard, {
        pool: { ...pool, accounts: [pool.accounts[0], ultra] },
        dashboard,
        mode: 'remaining',
        reveal: false,
      })
    );
    expect(markup).toMatch(
      // An aria-hidden spacer may follow the reason: wide tables use it to start the reason at the bars.
      /<li data-limit-id="five-hour" data-missing="true"[^>]*><span>5-hour remaining<\/span><em>No 5-hour limit<\/em>(?:<strong aria-hidden="true">(?:(?!<\/li>).)*<\/strong>)?<\/li>/
    );
  });
  test('every forecast state gets one chip shape with its own icon, and Ready is neutral', async () => {
    await i18n.changeLanguage('en');
    const chip = (forecastState: QuotaPool['forecastState'], savedData = false) => {
      const markup = renderToStaticMarkup(
        createElement(PoolCard, {
          pool: { ...pool, forecastState },
          dashboard,
          mode: 'remaining',
          reveal: false,
          savedData,
        })
      );
      const match = markup.match(/<span[^>]*data-chip-icon="([^"]+)"[^>]*data-tone="([^"]+)"/);
      return match ? { icon: match[1], tone: match[2] } : null;
    };
    expect(chip('ready')).toEqual({ icon: 'check', tone: 'neutral' });
    expect(chip('partial')).toEqual({ icon: 'partial', tone: 'warning' });
    expect(chip('stale')).toEqual({ icon: 'stale', tone: 'warning' });
    expect(chip('collecting')).toEqual({ icon: 'collecting', tone: 'neutral' });
    expect(chip('no-limit')).toEqual({ icon: 'info', tone: 'neutral' });
    expect(chip('ready', true)).toEqual({ icon: 'saved', tone: 'neutral' });
  });
  test('saved data qualifies forecasts once per card while retaining rate balances', async () => {
    await i18n.changeLanguage('en');
    const markup = renderToStaticMarkup(
      createElement(PoolCard, {
        pool: { ...pool, forecastState: 'ready' },
        dashboard,
        mode: 'burn',
        reveal: false,
        savedData: true,
      })
    );
    expect(markup).toContain('Forecast saved');
    // The snapshot is marked on the chart; the card doesn't repeat its time.
    expect(markup).toContain('Saved snapshot');
    expect(markup).not.toContain('Saved snapshot:');
    // The card's snapshot line dates every row, so rows don't repeat it.
    expect(markup).not.toContain('Saved observation');
    expect(markup).not.toContain('Forecast ready');
    expect(markup).not.toContain('>Current<');
    // Rate views keep the balance as the Now group's fact.
    expect(markup).toContain('<dt>Weekly remaining</dt><dd>73 <small>of 200 points</small></dd>');
    expect(markup).toContain('of 200 points');
    // Rates carry their unit on the number line.
    expect(markup).toContain('3<small> points/h</small>');
    expect(markup).not.toContain('· Recorded');
  });

  test('absent projections have no projected legend or implied depletion estimate', async () => {
    await i18n.changeLanguage('en');
    const markup = renderToStaticMarkup(
      createElement(PoolCard, {
        pool: { ...pool, projected: [] },
        dashboard,
        mode: 'remaining',
        reveal: false,
      })
    );
    expect(markup).not.toContain('>Projected<');
    expect(markup).toContain('Not reported');
    expect(markup).not.toContain('Not in this range');
  });

  test('rate chart excludes future reset/empty markers and projection legend', async () => {
    await i18n.changeLanguage('en');
    const markup = renderToStaticMarkup(
      createElement(PoolChart, { pool: { ...pool, poolEmptyAtMs: 950 }, dashboard, mode: 'burn' })
    );
    expect(markup).not.toContain('stroke-dasharray');
    expect(markup).not.toContain('>Projected<');
    expect(markup).not.toContain('Reset:');
    expect(markup).not.toContain('Pool empty:');
  });
  test('missing data is not presented as zero remaining', async () => {
    await i18n.changeLanguage('en');
    const markup = renderToStaticMarkup(
      createElement(PoolCard, {
        pool: {
          ...pool,
          remainingPoints: null,
          recorded: [],
          projected: [],
          forecastState: 'collecting',
        },
        dashboard,
        mode: 'remaining',
        reveal: false,
      })
    );
    // The value slot says the total is withheld, so it never passes for a value.
    expect(markup).toContain('<strong><span>Withheld</span></strong>');
    expect(markup).toContain('<p>Weekly quota remaining</p>');
    expect(markup).toContain('Collecting history');
    expect(markup).toContain('No observations in this range');
  });
  test('all six locales have matching keys and interpolation contracts', () => {
    const flatten = (value: Record<string, unknown>, prefix = ''): Record<string, string> =>
      Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) =>
          typeof item === 'string'
            ? [[prefix + key, item]]
            : Object.entries(flatten(item as Record<string, unknown>, `${prefix}${key}.`))
        )
      );
    const locales = ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko'].map((locale) =>
      flatten(JSON.parse(readFileSync(`src/i18n/locales/${locale}.json`, 'utf8')).quota_pool)
    );
    for (const locale of locales) {
      expect(Object.keys(locale).sort()).toEqual(Object.keys(locales[0]).sort());
      for (const key of Object.keys(locale))
        expect(locale[key].match(/{{\w+}}/g)?.sort()).toEqual(
          locales[0][key].match(/{{\w+}}/g)?.sort()
        );
    }
  });
});
