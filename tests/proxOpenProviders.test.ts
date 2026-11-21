import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from '../server/app';
import { ResetClaims } from '../server/quota/claims';
import { QuotaCollector } from '../server/quota/collector';
import { decodeNormalizedQuota } from '../src/domain/quotaWindows/normalized';
import { QuotaStore } from '../server/quota/store';
import { HOUR_MS, MANUAL_REFRESH_INTERVAL_MS } from '../server/quota/types';
import type { ProviderCatalogEntry } from '../src/domain/providerCatalog';
import type { DeploymentSource } from '../src/domain/providerSources/types';
import type { PoolDashboard, PoolProfileUpdate } from '../src/domain/quotaPool/types';
import {
  DEFAULT_VIEW_STATE,
  readViewState,
  resolveViewProvider,
  visibleProviders,
  writeViewState,
} from '../src/features/quotaPool/model/viewState';

const NOW = 1_800_000_000_000;
const KEY = 'synthetic-management-key';
const TEMP_DIRS: string[] = [];
afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'prox-open-providers-'));
  TEMP_DIRS.push(dir);
  return dir;
}

describe('open quota account schema', () => {
  test.each([
    ['pre-Antigravity', "'claude', 'codex'", 'codex'],
    ['Antigravity', "'claude', 'codex', 'antigravity'", 'antigravity'],
  ])('migrates %s accounts once and preserves references', (_schema, allowed, legacyProvider) => {
    const path = join(temporary(), 'quota.sqlite');
    using old = new Database(path);
    old.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE quota_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN (${allowed})),
        name TEXT NOT NULL,
        email TEXT,
        disabled INTEGER NOT NULL,
        retired INTEGER NOT NULL,
        lastSeenAtMs INTEGER NOT NULL,
        lastErrorAtMs INTEGER
      );
      CREATE TABLE quota_samples (
        accountId TEXT NOT NULL REFERENCES quota_accounts(id),
        window TEXT NOT NULL CHECK (window IN ('weekly', 'five-hour')),
        observedAtMs INTEGER NOT NULL,
        remainingPercent REAL,
        resetAtMs INTEGER,
        periodHours REAL,
        PRIMARY KEY (accountId, window, observedAtMs)
      );
      CREATE TABLE quota_account_sources (
        accountId TEXT PRIMARY KEY REFERENCES quota_accounts(id),
        instanceId TEXT NOT NULL,
        sourceAccountId TEXT NOT NULL UNIQUE
      );
      CREATE TABLE quota_account_plans (
        accountId TEXT PRIMARY KEY REFERENCES quota_accounts(id),
        plan TEXT NOT NULL,
        observedAtMs INTEGER NOT NULL
      );
    `);
    old
      .query('INSERT INTO quota_accounts VALUES (?, ?, ?, ?, 0, 0, ?, NULL)')
      .run('legacy', legacyProvider, 'old.json', 'old@example.test', NOW);
    old
      .query('INSERT INTO quota_samples VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy', 'weekly', NOW, 75, NOW + HOUR_MS, 168);
    old
      .query('INSERT INTO quota_account_sources VALUES (?, ?, ?)')
      .run('legacy', 'hub', 'legacy-alias');
    old.query('INSERT INTO quota_account_plans VALUES (?, ?, ?)').run('legacy', 'old-tier', NOW);

    const store = new QuotaStore(path);
    expect(store.listAccounts()[0]).toMatchObject({
      provider: legacyProvider,
      sourceAccountId: 'legacy-alias',
      plan: 'old-tier',
      email: 'old@example.test',
    });
    expect(store.latestSamples()).toEqual([
      {
        accountId: 'legacy',
        window: 'weekly',
        observedAtMs: NOW,
        remainingPercent: 75,
        resetAtMs: NOW + HOUR_MS,
        periodHours: 168,
      },
    ]);
    const id = store.accountIdFor('hub', 'new_provider', 'synthetic-index');
    const account = {
      id,
      instanceId: 'hub',
      provider: 'new_provider',
      name: 'new.json',
      email: null,
      disabled: false,
      retired: false,
      lastSeenAtMs: NOW,
      lastErrorAtMs: null,
    };
    store.recordInventory(account.provider, [account], NOW, 'hub');
    expect(() => store.recordInventory('Invalid!', [], NOW, 'hub')).toThrow(
      'Invalid quota provider'
    );
    store.close();
    expect(old.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => old.exec("DELETE FROM quota_accounts WHERE id = 'legacy'")).toThrow();
    expect(() =>
      old.exec("INSERT INTO quota_legacy_sources VALUES ('new_provider', 'hub')")
    ).toThrow();
    expect(() =>
      old
        .query(
          `
      INSERT INTO quota_reset_events (clientRequestId, accountId, provider, kind, outcome, requestedAtMs)
      VALUES ('test', ?, 'new_provider', 'test', 'failed', ?)
    `
        )
        .run(id, NOW)
    ).toThrow();
    expect(() =>
      old
        .query(
          `
      INSERT INTO quota_samples (accountId, window, observedAtMs) VALUES (?, 'monthly', ?)
    `
        )
        .run(id, NOW)
    ).toThrow();
    const schemaVersion = old.query('PRAGMA schema_version').get();
    const reopened = new QuotaStore(path);
    expect(reopened.listAccounts().map(({ provider }) => provider)).toEqual(
      [legacyProvider, 'new_provider'].sort()
    );
    expect(old.query('PRAGMA schema_version').get()).toEqual(schemaVersion);
    reopened.close();
  });
});

const PROVIDER = 'orbit-ai';
const OTHER_PROVIDER = 'other_cloud';
const credential = (provider: string, index = 'one', disabled = false) => ({
  provider,
  type: provider,
  auth_index: index,
  name: 'shared.json',
  email: 'private@example.test',
  disabled,
});

function entry(
  id: string = PROVIDER,
  lifecycle: ProviderCatalogEntry['lifecycle'] = 'active',
  supported = true
): ProviderCatalogEntry {
  return {
    id,
    displayName: id === PROVIDER ? 'Orbit AI' : id,
    source: 'plugin',
    pluginId: id,
    logo: null,
    lifecycle,
    oauth: null,
    credentials: {
      total: lifecycle === 'awaiting_auth' ? 0 : 1,
      active: lifecycle === 'active' ? 1 : 0,
      disabled: 0,
      problem: 0,
    },
    quota: { supported, reader: supported ? 'plugin' : 'none', pluginId: id, supportsReset: false },
  };
}

const reading = {
  subscription: { tierId: 'TEAM', tierName: 'Team' },
  groups: [
    {
      displayName: 'Orbit limits',
      buckets: [
        {
          id: 'account-week',
          window: 'Weekly',
          periodSeconds: 604800,
          scope: 'account',
          remainingFraction: 0.6,
          resetTime: new Date(NOW + 24 * HOUR_MS).toISOString(),
        },
        {
          id: 'secondary-week',
          window: 'Weekly backup',
          periodSeconds: 604800,
          scope: 'account',
          remainingFraction: 0.3,
        },
        {
          id: 'account-session',
          window: 'Session',
          period_seconds: 18000,
          scope: 'account',
          remaining_fraction: 0.7,
        },
        {
          id: 'model-week',
          window: 'Model weekly',
          periodSeconds: 604800,
          scope: 'model',
          remainingFraction: 0.9,
        },
        {
          id: 'month',
          window: 'Monthly',
          periodSeconds: 2592000,
          scope: 'account',
          remainingFraction: 0.1,
        },
      ],
    },
  ],
};

function fixture(initial: readonly string[] = ['hub-a']) {
  const directory = temporary();
  const keyFile = join(directory, 'management.key');
  writeFileSync(keyFile, KEY);
  const store = new QuotaStore(':memory:');
  let clock = NOW;
  const catalogs = new Map<string, unknown>();
  const credentials = new Map<string, ReturnType<typeof credential>[]>();
  const quota = new Map<string, unknown>();
  const calls: { hub: string; path: string; method: string; body: unknown }[] = [];
  let before: ((hub: string, path: string) => Promise<void>) | undefined;
  const source = (instanceId: string, providers = [PROVIDER]): DeploymentSource => ({
    instanceId,
    label: `Label ${instanceId}`,
    publicBasePath: `/${instanceId}`,
    aliases: [],
    authScope: instanceId,
    providers,
    upstreamOrigin: `https://${instanceId}.invalid`,
    managementKeyFile: keyFile,
  });
  const fetcher = Object.assign(
    async (input: string | Request | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const hub = url.hostname.replace('.invalid', '');
      const path = url.pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ hub, path, method: init?.method ?? 'GET', body });
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
      expect(init?.redirect).toBe('error');
      await before?.(hub, path);
      if (path === '/v8/management/providers') {
        return catalogs.has(hub)
          ? Response.json(catalogs.get(hub))
          : new Response(null, { status: 404 });
      }
      if (path === '/v8/management/credentials')
        return Response.json({ files: credentials.get(hub) ?? [] });
      if (path === '/v8/management/quota/fetch') return Response.json(quota.get(hub) ?? reading);
      if (path === '/v8/management/requests/api-call') {
        return Response.json({
          status_code: 200,
          body: {
            plan_type: 'plus',
            rate_limit: {
              primary_window: {
                used_percent: 20,
                limit_window_seconds: 604800,
                reset_at: (NOW + HOUR_MS) / 1000,
              },
              secondary_window: {
                used_percent: 20,
                limit_window_seconds: 18000,
                reset_at: (NOW + HOUR_MS) / 1000,
              },
            },
          },
        });
      }
      throw new Error('Unexpected fixture request');
    },
    { preconnect() {} }
  );
  const collector = new QuotaCollector(store, {
    sources: initial.map((id) => source(id)),
    revision: 'rev-1',
    fetcher,
    now: () => clock,
    sleep: async () => {},
  });
  const claims = new ResetClaims({ store, collector, now: () => clock });
  const handle = createHandler({ store, collector, keyFile, now: () => clock, claims });
  const request = (path: string, method = 'GET', body?: unknown, authenticated = true) =>
    handle(
      new Request(`http://history.invalid/v1/${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: authenticated ? { Authorization: `Bearer ${KEY}` } : {},
      })
    );
  return {
    source,
    store,
    collector,
    calls,
    credentials,
    catalogs,
    quota,
    request,
    catalog: (id: string, ...providers: ProviderCatalogEntry[]) =>
      catalogs.set(id, { instance_id: id, schema_version: 1, providers }),
    delay: (handler: typeof before) => {
      before = handler;
    },
    later: () => {
      clock += MANUAL_REFRESH_INTERVAL_MS + 1;
    },
    dashboard: async (query = '') =>
      (await (await request(`pools${query}`)).json()) as PoolDashboard,
    close() {
      collector.stop();
      store.close();
    },
  };
}

describe('discovery and additive collection', () => {
  test('hot-adds during an in-flight collection and keeps the original source binding', async () => {
    const f = fixture();
    try {
      f.catalog('hub-a', entry());
      f.catalog('hub-b', entry());
      f.credentials.set('hub-a', [credential(PROVIDER)]);
      f.credentials.set('hub-b', [credential(PROVIDER)]);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      f.delay(async (hub, path) => {
        if (hub === 'hub-a' && path.endsWith('/credentials')) {
          entered.resolve();
          await release.promise;
        }
      });
      const inFlight = f.collector.refresh();
      await entered.promise;
      const elsewhere = { ...f.source('hub-a'), upstreamOrigin: 'https://wrong.invalid' };
      f.collector.applySources([f.source('hub-b'), elsewhere, f.source('hub-b')], 'rev-2');
      release.resolve();
      await inFlight;
      expect(f.store.listAccounts().map((account) => account.instanceId)).toEqual(['hub-a']);
      expect(f.collector.revision).toBe('rev-2');
      f.collector.applySources([], 'rev-3');
      // A revision that adds nothing (a removal waits for a restart) is not applied.
      expect(f.collector.revision).toBe('rev-2');
      f.later();
      await f.collector.refresh();
      expect(f.collector.sources?.map((source) => source.instanceId)).toEqual(['hub-a', 'hub-b']);
      expect(
        f.store.listAccounts().map(({ instanceId, retired }) => [instanceId, retired])
      ).toEqual([
        ['hub-a', false],
        ['hub-b', false],
      ]);
      expect(f.calls.some((call) => call.hub === 'wrong')).toBe(false);
      expect(
        f.calls
          .filter(({ path }) => path.endsWith('/quota/fetch'))
          .map(({ hub }) => hub)
          .sort()
      ).toEqual(['hub-a', 'hub-a', 'hub-b']);
    } finally {
      f.close();
    }
  });

  test('a 404 leaves built-in reading intact and a later catalog failure retains discovered accounts', async () => {
    const f = fixture([]);
    try {
      f.collector.applySources([f.source('legacy', ['codex']), f.source('hub-a')], 'rev-2');
      f.credentials.set('legacy', [credential('codex'), credential(PROVIDER)]);
      f.catalog('hub-a', entry());
      f.credentials.set('hub-a', [credential(PROVIDER)]);
      await f.collector.refresh();
      expect(f.collector.issues).toEqual([]);
      expect(f.store.listAccounts().map(({ provider }) => provider)).toEqual(['codex', PROVIDER]);
      expect(
        f.calls.some(({ hub, path }) => hub === 'legacy' && path.endsWith('/quota/fetch'))
      ).toBe(false);
      const snapshot = f.store.listProviderCatalog('hub-a');
      f.catalogs.delete('hub-a');
      f.credentials.set('hub-a', []);
      f.later();
      await f.collector.refresh();
      await f.collector.syncInventory();
      expect(f.store.listProviderCatalog('hub-a')).toEqual(snapshot);
      expect(f.store.listAccounts().every(({ retired }) => !retired)).toBe(true);
      expect(f.collector.issues).toEqual([]);
      const dashboard = await f.dashboard();
      expect(dashboard.unpooled?.[0].accounts[0].windows).toHaveLength(5);
      expect(dashboard.combined?.all?.series?.remainingPoints).toBe(80);
    } finally {
      f.close();
    }
  });

  test('scopes same-name deletes to the instance through both immediate and late retirement', async () => {
    const f = fixture(['hub-a', 'hub-b']);
    try {
      for (const id of ['hub-a', 'hub-b']) {
        f.catalog(id, entry());
        f.credentials.set(id, [credential(PROVIDER)]);
      }
      await f.collector.syncInventory();
      f.credentials.clear();
      const deleted = await f.collector.syncInventory({
        instanceId: 'hub-a',
        deletedNames: ['shared.json'],
      });
      expect(deleted.purged).toHaveLength(1);
      expect(f.store.listAccounts()).toMatchObject([{ instanceId: 'hub-b', retired: true }]);
      expect(
        (
          await f.collector.syncInventory({
            instanceId: 'hub-a',
            deletedNames: ['shared.json'],
          })
        ).purged
      ).toEqual([]);
      expect(
        (await f.collector.syncInventory({ deletedNames: ['shared.json'] })).purged
      ).toHaveLength(1);
      expect(f.store.listAccounts()).toEqual([]);
    } finally {
      f.close();
    }
  });
});

describe('provider promotion and profiles', () => {
  const profile: PoolProfileUpdate = {
    instanceId: 'hub-a',
    provider: PROVIDER,
    weeklyWindowId: 'account-week',
    fiveHourWindowId: null,
    planUnits: { team: 2.5 },
    enabled: true,
  };

  test('waiting, unpooled, promoted, remapped and opted-out quota keeps independent totals', async () => {
    const f = fixture([]);
    try {
      f.collector.applySources([f.source('legacy', ['codex']), f.source('hub-a')], 'rev-2');
      f.credentials.set('legacy', [credential('codex')]);
      f.catalog(
        'hub-a',
        entry(PROVIDER, 'awaiting_auth'),
        entry(OTHER_PROVIDER, 'awaiting_auth', false)
      );
      await f.collector.refresh();
      const beforeAuth = await f.dashboard();
      expect(beforeAuth.awaitingAuth).toContainEqual({
        instanceId: 'hub-a',
        sourceLabel: 'Label hub-a',
        provider: PROVIDER,
        displayName: 'Orbit AI',
        quotaSupported: true,
      });
      expect(beforeAuth.unpooled).toEqual([]);
      expect(beforeAuth.combined?.[PROVIDER]).toBeUndefined();
      expect(beforeAuth.combined?.all?.series?.capacityPoints).toBe(100);

      f.catalog('hub-a', entry(), entry(OTHER_PROVIDER, 'active', false));
      f.credentials.set('hub-a', [credential(PROVIDER), credential(OTHER_PROVIDER)]);
      f.later();
      const change = await f.collector.syncInventory();
      expect(change.added).toHaveLength(2);
      await f.collector.pollAdded(change.added);
      const active = await f.dashboard();
      expect(active.awaitingAuth).toEqual([]);
      expect(active.unpooled).toHaveLength(2);
      const account = active.unpooled?.find(({ provider }) => provider === PROVIDER)?.accounts[0];
      expect(account).toMatchObject({ status: 'ok', planLabel: 'Team', planType: 'team' });
      expect(account?.windows[0]).toMatchObject({
        id: 'account-week',
        scope: 'account',
        periodHours: 168,
        remainingPercent: 60,
      });
      expect(
        active.unpooled?.find(({ provider }) => provider === OTHER_PROVIDER)?.accounts[0]
      ).toMatchObject({ status: 'no-reader', observedAtMs: null, windows: [] });
      expect(JSON.stringify(active)).not.toContain('private@example.test');
      expect((await f.dashboard('?reveal=true')).unpooled?.[0].accounts[0].identifier).toBe(
        'private@example.test'
      );
      expect(f.calls.filter(({ path }) => path.endsWith('/quota/fetch'))).toEqual([
        {
          hub: 'hub-a',
          path: '/v8/management/quota/fetch',
          method: 'POST',
          body: { auth_index: 'one' },
        },
      ]);
      expect(active.combined?.all?.series?.remainingPoints).toBe(80);
      expect(f.store.latestSamples().some(({ accountId }) => accountId === account?.id)).toBe(
        false
      );
      expect(
        (
          await f.request('resets/claim', 'POST', {
            accountId: account?.id,
            clientRequestId: 'unsupported-provider',
          })
        ).status
      ).toBe(400);
      expect(f.store.listResetEvents({})).toEqual([]);

      expect((await f.request('pool-profiles', 'GET', undefined, false)).status).toBe(401);
      for (const patch of [
        { instanceId: 'absent' },
        { provider: 'INVALID' },
        { provider: 'codex' },
        { weeklyWindowId: 'absent' },
        { weeklyWindowId: 'model-week' },
        { weeklyWindowId: 'month' },
        { weeklyWindowId: 'account-session' },
        { weeklyWindowId: '  ' },
        { fiveHourWindowId: 'account-week' },
        { weeklyWindowId: null },
        { planUnits: { team: 0 } },
        { planUnits: { team: -1 } },
        { planUnits: { team: '2' } },
      ]) {
        expect((await f.request('pool-profiles', 'PUT', { ...profile, ...patch })).status).toBe(
          400
        );
      }
      expect(
        (await f.request('pool-profiles', 'PUT', { ...profile, provider: 'phantom' })).status
      ).toBe(404);
      const written = await f.request('pool-profiles', 'PUT', profile);
      expect(written.status).toBe(200);
      const record = ((await written.json()) as { profile: unknown }).profile;
      expect(record).toMatchObject(profile);
      expect(await (await f.request('pool-profiles')).json()).toEqual({ profiles: [record] });
      f.later();
      await f.collector.refresh();
      const pooled = await f.dashboard();
      expect(pooled.poolProfiles).toEqual([record]);
      expect(pooled.unpooled?.map(({ provider }) => provider)).toEqual([OTHER_PROVIDER]);
      expect(pooled.pools.find(({ provider }) => provider === PROVIDER)).toMatchObject({
        displayName: 'Orbit AI',
        remainingPoints: 150,
        capacityPoints: 250,
        accounts: [{ plan: { label: 'Team', known: true, capacityPoints: 250 }, resets: null }],
      });
      expect(pooled.combined?.all?.series?.remainingPoints).toBe(230);
      expect(pooled.combined?.[PROVIDER]?.layers?.[0].displayName).toBe('Orbit AI');
      const fiveHour = await f.dashboard('?window=five-hour');
      expect(fiveHour.combined?.all?.series?.remainingPoints).toBe(80);
      expect(fiveHour.pools.find(({ provider }) => provider === PROVIDER)?.forecastState).toBe(
        'no-limit'
      );
      expect(await (await f.request('accounts')).json()).toMatchObject({
        accounts: [{ provider: 'codex' }],
      });

      expect(
        (
          await f.request('pool-profiles', 'PUT', {
            ...profile,
            weeklyWindowId: 'secondary-week',
            planUnits: {},
          })
        ).status
      ).toBe(200);
      f.later();
      await f.collector.refresh();
      const remapped = await f.dashboard();
      const newPool = remapped.pools.find(({ provider }) => provider === PROVIDER);
      expect(newPool).toMatchObject({
        remainingPoints: 30,
        accounts: [{ plan: { known: false, capacityPoints: 100 } }],
      });
      expect(
        newPool?.recorded
          .filter(({ remainingPoints }) => remainingPoints !== null)
          .map(({ remainingPoints }) => remainingPoints)
      ).toEqual([30]);
      expect(
        (await f.request('pool-profiles?instanceId=hub-a&provider=orbit-ai', 'DELETE')).status
      ).toBe(204);
      const optedOut = await f.dashboard();
      expect(optedOut.poolProfiles).toEqual([]);
      expect(optedOut.unpooled?.map(({ provider }) => provider)).toEqual([
        PROVIDER,
        OTHER_PROVIDER,
      ]);
      expect(optedOut.combined?.all?.series?.remainingPoints).toBe(80);
    } finally {
      f.close();
    }
  });

  test('legacy quota buckets render; ambiguous IDs are display-only and invalid fractions fail', () => {
    const result = decodeNormalizedQuota({
      groups: [
        { buckets: [{ window: 'Shared', remainingFraction: 0.8 }] },
        {
          buckets: [
            { window: 'Shared', remaining_fraction: 0.4 },
            { window: 'Legacy', remainingFraction: 0.5 },
          ],
        },
      ],
    });
    expect(
      result.windows.map(({ id, selectable, remainingPercent }) => [
        id,
        selectable,
        remainingPercent,
      ])
    ).toEqual([
      ['display:0', false, 80],
      ['display:1', false, 40],
      ['Legacy', undefined, 50],
    ]);
    expect(() =>
      decodeNormalizedQuota({ groups: [{ buckets: [{ id: 'invalid', remainingFraction: 2 }] }] })
    ).toThrow('Invalid normalized quota bucket');
  });
});

test('dynamic provider view state validates, round trips and falls back when absent', () => {
  const view = { ...DEFAULT_VIEW_STATE, provider: 'orbit-ai', window: 'five-hour' } as const;
  const params = writeViewState(new URLSearchParams('keep=1'), view);
  expect(readViewState(params)).toEqual(view);
  expect(params.get('keep')).toBe('1');
  expect(readViewState(new URLSearchParams('provider=Orbit!')).provider).toBe('all');
  const choices = visibleProviders([
    { provider: 'orbit-ai' },
    { provider: 'all' },
    { provider: 'orbit-ai' },
    { provider: 'Invalid' },
    { provider: 'antigravity' },
  ]);
  expect(choices).toEqual(['all', 'claude', 'codex', ':all', 'antigravity', 'orbit-ai']);
  expect(readViewState(new URLSearchParams('provider=%3Aall')).provider).toBe(':all');
  expect(resolveViewProvider('orbit-ai', choices)).toBe('orbit-ai');
  expect(resolveViewProvider('missing', choices)).toBe('all');
});
