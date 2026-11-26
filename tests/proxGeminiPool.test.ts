import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAccounts } from '../server/quota/accounts';
import { ResetClaimRefusal, ResetClaims } from '../server/quota/claims';
import { QuotaCollector, quotaSamples } from '../server/quota/collector';
import { buildDashboard, type DashboardOptions } from '../server/quota/domain';
import { planWeight } from '../server/quota/plans';
import { QuotaStore } from '../server/quota/store';
import { DAY_MS, HOUR_MS } from '../server/quota/types';
import { validateSourceManifest } from '../src/domain/providerSources/manifest';
import { laneOf, poolWindowId } from '../src/domain/quotaWindows/lanes';
import {
  readViewState,
  resolveViewProvider,
  visibleProviders,
} from '../src/features/quotaPool/model/viewState';
import { CLAUDE_USAGE_URL } from '../src/utils/quota/constants';

const NOW = 1_800_000_000_000;
const SENTINEL = 'SYNTHETIC_PRIVATE_GEMINI_VALUE';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'prox-gemini-pool-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** The retrieveUserQuotaSummary shape the stored history was decoded from (2026-11-21), values synthetic. */
function summary(geminiWeekly = 0.9, gemini5h = 0.75) {
  return {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
            remainingFraction: geminiWeekly,
          },
          {
            bucketId: 'gemini-5h',
            displayName: 'Five Hour Limit Remaining',
            window: '5h',
            resetTime: new Date(NOW + 2 * HOUR_MS).toISOString(),
            remainingFraction: gemini5h,
          },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          {
            bucketId: '3p-weekly',
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
            remainingFraction: 0.5,
          },
          {
            bucketId: '3p-5h',
            displayName: 'Five Hour Limit Remaining',
            window: '5h',
            resetTime: new Date(NOW + 2 * HOUR_MS).toISOString(),
            remainingFraction: 1,
          },
        ],
      },
    ],
  };
}

function fixture() {
  const root = temporary();
  const source = (instanceId: string, providers: string[]) => {
    const managementKeyFile = join(root, `${instanceId}.key`);
    writeFileSync(managementKeyFile, `synthetic-key-${instanceId}`);
    return {
      instanceId,
      label: `Label ${instanceId}`,
      publicBasePath: `/${instanceId}`,
      aliases: [],
      authScope: 'shared',
      providers,
      upstreamOrigin: `http://${instanceId}.invalid`,
      managementKeyFile,
    };
  };
  const manifest = validateSourceManifest({
    schemaVersion: 1,
    defaultInstanceId: 'claude-src',
    history: { upstreamOrigin: 'http://history.invalid', managementKeyFile: join(root, 'x.key') },
    sources: [source('claude-src', ['claude']), source('gemini-src', ['antigravity'])],
  });
  const inventories = new Map<string, unknown>([
    [
      'claude-src',
      {
        files: [
          {
            provider: 'claude',
            type: 'claude',
            auth_index: 'claude-index',
            name: 'claude.json',
            email: 'claude@example.test',
            disabled: false,
          },
        ],
      },
    ],
    [
      'gemini-src',
      {
        files: [
          {
            provider: 'antigravity',
            type: 'antigravity',
            auth_index: 'gemini-index',
            name: 'antigravity.json',
            email: 'gemini@example.test',
            disabled: false,
            project_id: 'synthetic-project',
            metadata: { access_token: SENTINEL },
          },
        ],
      },
    ],
  ]);
  const calls: { instanceId: string; path: string; body?: Record<string, unknown> }[] = [];
  const fetcher = Object.assign(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const instanceId = url.hostname.replace('.invalid', '');
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ instanceId, path: url.pathname, body });
      if (!body) return Response.json(inventories.get(instanceId));
      if (body.url === `${CLAUDE_USAGE_URL}?cedar_ember=1&skip_spend=1`)
        return Response.json({
          status_code: 200,
          body: {
            seven_day: { utilization: 20, resets_at: new Date(NOW + DAY_MS).toISOString() },
            five_hour: { utilization: 20, resets_at: new Date(NOW + HOUR_MS).toISOString() },
          },
        });
      return Response.json({ status_code: 404, body: '' });
    },
    { preconnect: () => {} }
  ) satisfies typeof fetch;
  const store = new QuotaStore(':memory:');
  cleanups.push(() => store.close());
  const collector = new QuotaCollector(store, {
    sources: manifest.sources,
    revision: 'synthetic-revision',
    fetcher,
    now: () => NOW,
  });
  cleanups.push(() => collector.stop());
  /** The Gemini account as prox-history stored it before its hub was taken down. */
  const seedGemini = (plan = 'g1-ultra-lite-tier') => {
    const id = store.accountIdFor('gemini-src', 'antigravity', 'gemini-index');
    store.recordInventory(
      'antigravity',
      [
        {
          id,
          instanceId: 'gemini-src',
          provider: 'antigravity',
          name: 'antigravity.json',
          email: 'gemini@example.test',
          disabled: false,
          retired: false,
          lastSeenAtMs: NOW,
          lastErrorAtMs: null,
        },
      ],
      NOW,
      'gemini-src'
    );
    store.recordPlan(id, plan, NOW, 0);
    store.recordSamples(quotaSamples('antigravity', id, summary(), NOW).samples);
    return id;
  };
  const options: DashboardOptions = {
    nowMs: NOW,
    window: 'weekly',
    lookbackHours: 3,
    multiplier: 1,
    offsetDays: 0,
    reveal: false,
  };
  const dashboard = (window: DashboardOptions['window'] = 'weekly') =>
    buildDashboard(
      store.listAccounts(),
      store.listSamples(0, NOW),
      { ...options, window },
      {
        historyStartedAtMs: NOW,
        lastRefreshAtMs: NOW,
        nextRefreshAtMs: NOW,
        refreshing: false,
        issues: collector.issues,
        sources: collector.sources,
        windows: collector.windows,
      }
    );
  return { store, collector, calls, dashboard, seedGemini };
}

describe('Gemini (Antigravity) in the quota pool', () => {
  test('a source declaring Antigravity is never inventoried for it, and nothing reads its quota', async () => {
    const f = fixture();
    const id = f.seedGemini();
    await f.collector.refresh();

    expect(
      f.collector.inventorySources.map(({ instanceId, provider }) => [instanceId, provider])
    ).toEqual([
      ['claude-src', 'claude'],
      ['claude-src', 'codex'],
    ]);
    // No request names the Antigravity credential: no quota read, plan read or hub quota fetch.
    expect(JSON.stringify(f.calls)).not.toContain('gemini-index');
    expect(f.calls.filter((call) => call.instanceId === 'gemini-src' && call.body)).toEqual([]);

    // The row's Refresh reads nothing either, and the stored readings stay as they were.
    const sent = f.calls.length;
    expect(await f.collector.refreshAccount(id)).toBe(false);
    expect(JSON.stringify(f.calls.slice(sent))).not.toContain('gemini-index');
    expect(f.store.listSamples(0, NOW).filter((sample) => sample.accountId === id)).toHaveLength(2);
    expect(f.store.listAccounts().find((account) => account.id === id)).toMatchObject({
      disabled: false,
      retired: false,
    });

    // Stored Gemini history stays visible even while that source is still in the manifest,
    // without claiming a live balance or adding an empty Gemini card beside the Claude hub.
    const weekly = f.dashboard('weekly');
    expect(weekly.pools.map((entry) => [entry.instanceId, entry.provider])).toEqual([
      ['claude-src', 'claude'],
      ['gemini-src', 'antigravity'],
    ]);
    const gemini = weekly.pools.find((entry) => entry.provider === 'antigravity')!;
    expect(gemini.recorded.at(-1)?.remainingPoints).toBeCloseTo(450, 6);
    expect(gemini.remainingPoints).toBeNull();
    expect(JSON.stringify(weekly)).not.toContain(SENTINEL);
  });

  test('a Gemini source taken out of the manifest keeps its stored pool and history', async () => {
    const f = fixture();
    f.seedGemini();
    await f.collector.refresh();
    // Built as prox-history does after the Gemini hub left the manifest: only the Claude source
    // is configured, the Gemini account and its samples are still stored.
    const pools = buildDashboard(
      f.store.listAccounts(),
      f.store.listSamples(0, NOW),
      {
        nowMs: NOW,
        window: 'weekly',
        lookbackHours: 3,
        multiplier: 1,
        offsetDays: 0,
        reveal: false,
      },
      {
        historyStartedAtMs: NOW,
        lastRefreshAtMs: NOW,
        nextRefreshAtMs: NOW,
        refreshing: false,
        issues: [],
        sources: f.collector.sources.filter((source) => source.instanceId !== 'gemini-src'),
      }
    ).pools;
    const gemini = pools.find((pool) => pool.provider === 'antigravity')!;
    expect(gemini.instanceId).toBe('gemini-src');
    expect(gemini.accountCount).toBe(1);
    expect(gemini.recorded.at(-1)?.remainingPoints).toBeCloseTo(450, 6);
  });

  test('a disabled account keeps the history it recorded, and leaves the pool after it', async () => {
    const f = fixture();
    f.seedGemini();
    await f.collector.refresh();
    // The suspended Gemini credential was disabled before its source was removed.
    const accounts = f.store
      .listAccounts()
      .map((account) =>
        account.provider === 'antigravity' ? { ...account, disabled: true } : account
      );
    const at = (nowMs: number) =>
      buildDashboard(
        accounts,
        f.store.listSamples(0, NOW),
        {
          nowMs,
          window: 'weekly',
          lookbackHours: 3,
          multiplier: 1,
          offsetDays: 0,
          reveal: false,
        },
        {
          historyStartedAtMs: NOW,
          lastRefreshAtMs: NOW,
          nextRefreshAtMs: NOW,
          refreshing: false,
          issues: [],
          sources: f.collector.sources.filter((source) => source.instanceId !== 'gemini-src'),
        }
      ).pools.find((pool) => pool.provider === 'antigravity')!;
    const gemini = at(NOW);
    expect(gemini.accounts[0].status).toBe('disabled');
    expect(gemini.eligibleCount).toBe(0);
    expect(gemini.recorded.find((point) => point.atMs === NOW)?.remainingPoints).toBeCloseTo(
      450,
      6
    );
    // Its last reading stays the last point; nothing is drawn for it afterwards.
    expect(at(NOW + DAY_MS).recorded.at(-1)).toMatchObject({ atMs: NOW });
  });

  test("the combined chart keeps a retired, disabled Gemini account's history", async () => {
    const f = fixture();
    f.seedGemini();
    await f.collector.refresh();
    const accounts = f.store
      .listAccounts()
      .map((account) =>
        account.provider === 'antigravity' ? { ...account, disabled: true } : account
      );
    const combined = buildDashboard(
      accounts,
      f.store.listSamples(0, NOW),
      {
        nowMs: NOW,
        window: 'weekly',
        lookbackHours: 3,
        multiplier: 1,
        offsetDays: 0,
        reveal: false,
      },
      {
        historyStartedAtMs: NOW,
        lastRefreshAtMs: NOW,
        nextRefreshAtMs: NOW,
        refreshing: false,
        issues: [],
        sources: f.collector.sources.filter((source) => source.instanceId !== 'gemini-src'),
      }
    ).combined;
    const last = (
      series: { recorded: { atMs: number; remainingPoints: number | null }[] } | null | undefined
    ) => series?.recorded.find((point) => point.atMs === NOW)?.remainingPoints;
    // Claude reads 80 of 100 points; Gemini's last reading is 450 of its 500.
    expect(last(combined?.all?.series)).toBeCloseTo(80 + 450, 6);
    expect(last(combined?.antigravity?.series)).toBeCloseTo(450, 6);
    // The dormant Gemini pool neither holds the total's forecast nor shows a live balance.
    expect(combined?.all?.series?.forecastState).toBe('collecting');
    expect(combined?.antigravity?.series?.remainingPoints).toBeNull();
    expect(combined?.all?.layers?.map((layer) => layer.provider)).toEqual([
      'claude',
      'antigravity',
    ]);
  });

  test('a reading without the Gemini group records explicit missing windows, not zero', () => {
    const { samples } = quotaSamples(
      'antigravity',
      'account',
      { groups: [summary().groups[1]] },
      NOW
    );
    expect(samples.map((s) => [s.window, s.remainingPercent])).toEqual([
      ['weekly', null],
      ['five-hour', null],
    ]);
    expect(() => quotaSamples('antigravity', 'account', { nope: true }, NOW)).toThrow();
    expect(poolWindowId('antigravity', 'weekly')).toBe('weekly');
    expect(poolWindowId('antigravity', 'five-hour')).toBe('five-hour');
  });

  test('non-Gemini buckets cannot collide with Gemini pool ids even if named gemini-weekly or weekly', () => {
    const colliding = {
      groups: [
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
              remainingFraction: 0.31,
            },
            {
              bucketId: 'weekly',
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
              remainingFraction: 0.31,
            },
            {
              bucketId: 'five-hour',
              displayName: 'Five Hour Limit Remaining',
              window: '5h',
              resetTime: new Date(NOW + 2 * HOUR_MS).toISOString(),
              remainingFraction: 0.31,
            },
          ],
        },
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'weekly',
              displayName: 'Unrecognized Weekly',
              window: 'weekly',
              resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
              remainingFraction: 0.25,
            },
            {
              bucketId: 'toString',
              displayName: 'Inherited Key Bucket',
              window: 'weekly',
              resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
              remainingFraction: 0.4,
            },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: 'toString',
              displayName: 'Inherited Key Third Party',
              window: 'weekly',
              resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
              remainingFraction: 0.5,
            },
          ],
        },
      ],
    };
    const { samples, windows } = quotaSamples('antigravity', 'account', colliding, NOW);
    expect(samples.map((s) => [s.window, s.remainingPercent])).toEqual([
      ['weekly', null],
      ['five-hour', null],
    ]);
    expect(windows.map((w) => [w.id, laneOf('antigravity', w.id)])).toEqual([
      ['claude-and-gpt-models:five-hour', 'model'],
      ['claude-and-gpt-models:gemini-weekly', 'model'],
      ['claude-and-gpt-models:weekly', 'model'],
      ['gemini-models:toString', 'model'],
      ['gemini-models:weekly', 'model'],
      ['claude-and-gpt-models:toString', 'model'],
    ]);
    // Inherited object keys must stay plain strings and survive JSON serialization intact.
    const serialized = JSON.parse(JSON.stringify(windows)) as typeof windows;
    expect(
      serialized.every((w) => typeof w.id === 'string' && typeof w.labelKey === 'string')
    ).toBe(true);
  });

  test('a malformed or ambiguous Antigravity reading is rejected, never recorded as 0 or missing', () => {
    const reading =
      (buckets: unknown[], displayName = 'Gemini Models') =>
      () =>
        quotaSamples('antigravity', 'account', { groups: [{ displayName, buckets }] }, NOW);
    for (const badFraction of ['bad', '%', '  % ', 1.5]) {
      expect(reading([{ bucketId: 'gemini-weekly', remainingFraction: badFraction }])).toThrow();
    }
    // Unpersistable or out-of-Date-range reset times, on a pool window and on a model window.
    for (const resetTime of ['1e20', '8640000000000001']) {
      expect(
        reading([
          { bucketId: 'gemini-weekly', window: 'weekly', resetTime, remainingFraction: 0.9 },
        ])
      ).toThrow();
      expect(
        reading(
          [{ bucketId: '3p-weekly', window: 'weekly', resetTime, remainingFraction: 0.5 }],
          'Claude and GPT models'
        )
      ).toThrow();
    }
    // Two pool buckets with one id and different balances.
    const resetTime = new Date(NOW + 5 * DAY_MS).toISOString();
    expect(
      reading([
        { bucketId: 'gemini-weekly', window: 'weekly', resetTime, remainingFraction: 0.9 },
        { bucketId: 'gemini-weekly', window: 'weekly', resetTime, remainingFraction: 0.2 },
      ])
    ).toThrow();
  });

  test('Google AI Ultra counts 2000 points, Ultra Lite 500; other tiers stay unknown', () => {
    expect(planWeight('antigravity', 'g1-ultra-tier')).toEqual({
      multiplier: 20,
      label: 'Ultra',
      known: true,
    });
    // Ultra Lite is the lower tier (user direction, 21 Nov 2026): 5 base plans, like Claude Max.
    expect(planWeight('antigravity', 'g1-ultra-lite-tier')).toEqual({
      multiplier: 5,
      label: 'Ultra Lite',
      known: true,
    });
    expect(planWeight('antigravity', 'g1-pro-tier')).toEqual({
      multiplier: 1,
      label: 'g1-pro-tier',
      known: false,
    });
  });

  test('/v1/accounts still serves only Claude and Codex accounts', async () => {
    const f = fixture();
    f.seedGemini();
    await f.collector.refresh();
    const body = buildAccounts({
      accounts: f.store.listAccounts(),
      latestSamples: f.store.latestSamples(),
      windows: f.collector.windows,
      resets: f.collector.resets,
      billing: f.collector.billing,
      balances: f.collector.balances,
      nowMs: NOW,
      reveal: false,
      collection: { lastRefreshAtMs: NOW, nextRefreshAtMs: NOW, refreshing: false },
    });
    expect(body.accounts.map((account) => account.provider)).toEqual(['claude']);
  });

  test('a reset claim on a Gemini account is refused before anything is sent', async () => {
    const f = fixture();
    f.seedGemini();
    await f.collector.refresh();
    const account = f.store.listAccounts().find((entry) => entry.provider === 'antigravity')!;
    const sent = f.calls.length;
    const claims = new ResetClaims({ store: f.store, collector: f.collector, now: () => NOW });
    const refusal = await claims
      .claim({ accountId: account.id, clientRequestId: 'synthetic-request' })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ResetClaimRefusal);
    expect((refusal as ResetClaimRefusal).httpStatus).toBe(400);
    expect(f.calls.length).toBe(sent);
    expect(f.store.listResetEvents({})).toEqual([]);
  });
});

describe('quota_accounts provider constraint migration', () => {
  test('an existing claude/codex-only database accepts Antigravity and keeps every row', () => {
    const path = join(temporary(), 'quota.sqlite');
    const db = new Database(path);
    // The schema as shipped before Antigravity joined the pool.
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE quota_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        name TEXT NOT NULL, email TEXT,
        disabled INTEGER NOT NULL CHECK (disabled IN (0, 1)),
        retired INTEGER NOT NULL CHECK (retired IN (0, 1)),
        lastSeenAtMs INTEGER NOT NULL, lastErrorAtMs INTEGER, retiredAtMs INTEGER
      );
      CREATE INDEX quota_accounts_provider ON quota_accounts(provider);
      CREATE TABLE quota_samples (
        accountId TEXT NOT NULL REFERENCES quota_accounts(id),
        window TEXT NOT NULL, observedAtMs INTEGER NOT NULL, remainingPercent REAL,
        resetAtMs INTEGER, periodHours REAL, PRIMARY KEY (accountId, window, observedAtMs)
      );
      CREATE TABLE quota_account_sources (
        accountId TEXT PRIMARY KEY REFERENCES quota_accounts(id),
        instanceId TEXT NOT NULL, sourceAccountId TEXT NOT NULL UNIQUE
      );
      CREATE TABLE quota_account_plans (
        accountId TEXT PRIMARY KEY REFERENCES quota_accounts(id),
        plan TEXT NOT NULL, observedAtMs INTEGER NOT NULL
      );
      INSERT INTO quota_accounts VALUES ('c1', 'claude', 'c.json', 'c@example.test', 0, 0, ${NOW}, NULL, NULL);
      INSERT INTO quota_samples VALUES ('c1', 'weekly', ${NOW}, 80, ${NOW + DAY_MS}, 168);
      INSERT INTO quota_account_sources VALUES ('c1', 'claude-src', 'claude-src:c1');
      INSERT INTO quota_account_plans VALUES ('c1', 'default_claude_max', ${NOW});
    `);
    db.close();

    for (let open = 0; open < 2; open += 1) {
      const store = new QuotaStore(path, () => NOW);
      store.recordInventory(
        'antigravity',
        [
          {
            id: 'gemini-src:antigravity:g1',
            provider: 'antigravity',
            instanceId: 'gemini-src',
            name: 'g.json',
            email: null,
            disabled: false,
            retired: false,
            lastSeenAtMs: NOW,
            lastErrorAtMs: null,
          },
        ],
        NOW,
        'gemini-src'
      );
      expect(store.listAccounts().map((a) => [a.id, a.provider, a.plan ?? null])).toEqual([
        ['gemini-src:antigravity:g1', 'antigravity', null],
        ['c1', 'claude', 'default_claude_max'],
      ]);
      expect(store.listSamples(0, NOW).map((s) => s.accountId)).toEqual(['c1']);
      store.close();
    }
    const check = new Database(path, { readonly: true });
    expect(check.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      check
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'quota_accounts'"
        )
        .all()
        .map((row) => row.name)
    ).toContain('quota_accounts_provider');
    const migratedCols = check.query('PRAGMA table_info(quota_accounts)').all();
    const migratedSql = check
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'quota_accounts'"
      )
      .get()?.sql;
    check.close();

    // Fresh and migrated databases share the exact same table definition.
    const freshPath = join(temporary(), 'fresh.sqlite');
    const freshStore = new QuotaStore(freshPath, () => NOW);
    freshStore.close();
    const freshCheck = new Database(freshPath, { readonly: true });
    expect(migratedCols).toEqual(freshCheck.query('PRAGMA table_info(quota_accounts)').all());
    const normalizeSql = (sql: string | undefined) =>
      sql?.replace('"quota_accounts"', 'quota_accounts').replace(/\s+/g, ' ').trim();
    expect(normalizeSql(migratedSql)).toBe(
      normalizeSql(
        freshCheck
          .query<{ sql: string }, []>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'quota_accounts'"
          )
          .get()?.sql
      )
    );
    freshCheck.close();
  });
});

describe('Quota Management view state', () => {
  test('a link can select the Gemini pool, and installations without Gemini hide it and fall back', () => {
    expect(readViewState(new URLSearchParams('provider=antigravity')).provider).toBe('antigravity');
    const withoutGemini = visibleProviders([{ provider: 'claude' }, { provider: 'codex' }]);
    const withGemini = visibleProviders([{ provider: 'claude' }, { provider: 'antigravity' }]);
    expect(withoutGemini).toEqual(['all', 'claude', 'codex']);
    expect(withGemini).toEqual(['all', 'claude', 'codex', 'antigravity']);
    expect(resolveViewProvider('antigravity', withoutGemini)).toBe('all');
    expect(resolveViewProvider('antigravity', withGemini)).toBe('antigravity');
  });
});
