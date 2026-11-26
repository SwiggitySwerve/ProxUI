import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { QuotaCollector, quotaSamples } from '../server/quota/collector';
import {
  AGY_ACTIVE_TTL_MS,
  normalizeAgyCliUsage,
  parseAgySnapshotEnvelope,
} from '../server/quota/agySnapshot';
import { buildDashboard, type DashboardOptions } from '../server/quota/domain';
import { QuotaStore } from '../server/quota/store';
import { HOUR_MS } from '../server/quota/types';
import { validateSourceManifest } from '../src/domain/providerSources/manifest';
import { laneOf } from '../src/domain/quotaWindows/lanes';
import { CLAUDE_USAGE_URL } from '../src/utils/quota/constants';

const IN_USE_FIXTURE = JSON.parse(
  readFileSync(resolve(import.meta.dir, 'fixtures/agy-usage/in-use.json'), 'utf8')
) as Record<string, unknown>;

const SCRIPT_PATH = resolve(import.meta.dir, '../deploy/prox-agy-usage.sh');
const NOW = Date.parse('2026-11-26T00:31:00Z');
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tempDir(prefix = 'prox-agy-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeEnvelope(
  observedAtMs: number,
  overrides: {
    geminiWeekly?: number;
    gemini5h?: number;
    weeklyReset?: string;
    fiveHourReset?: string;
    plan?: string | null;
    instanceId?: string;
  } = {}
) {
  const usage = structuredClone(IN_USE_FIXTURE) as {
    command: {
      data: {
        groups: {
          name: string;
          buckets: {
            id: string;
            remaining_fraction: number;
            reset_time: string;
          }[];
        }[];
      };
    };
  };
  const gemini = usage.command.data.groups[0].buckets;
  if (overrides.geminiWeekly !== undefined) gemini[0].remaining_fraction = overrides.geminiWeekly;
  if (overrides.weeklyReset !== undefined) gemini[0].reset_time = overrides.weeklyReset;
  if (overrides.gemini5h !== undefined) gemini[1].remaining_fraction = overrides.gemini5h;
  if (overrides.fiveHourReset !== undefined) gemini[1].reset_time = overrides.fiveHourReset;
  return JSON.stringify({
    schemaVersion: 1,
    instanceId: overrides.instanceId ?? 'gemini-primary',
    sourceLabel: 'Gemini',
    observedAtMs,
    agyVersion: '1.5.17',
    ...(overrides.plan === null ? {} : { plan: overrides.plan ?? 'g1-ultra-tier' }),
    usage,
  });
}

function collectorFixture() {
  const dir = tempDir();
  const keyFile = join(dir, 'management-key');
  const snapshotPath = join(dir, 'agy-usage.json');
  writeFileSync(keyFile, 'synthetic-key');
  const manifest = validateSourceManifest({
    schemaVersion: 1,
    defaultInstanceId: 'claude-primary',
    history: { upstreamOrigin: 'http://127.0.0.1:18319', managementKeyFile: keyFile },
    sources: [
      {
        instanceId: 'claude-primary',
        label: 'Claude',
        publicBasePath: '/claude',
        aliases: [],
        authScope: 'test',
        providers: ['claude'],
        upstreamOrigin: 'http://claude-primary.invalid',
        managementKeyFile: keyFile,
      },
    ],
  });
  let claudeRemaining = 0.8;
  const fetcher = Object.assign(
    async (_input: string | URL | Request, init: RequestInit = {}) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      if (!body) {
        return Response.json({
          files: [
            {
              auth_index: 'claude-1',
              name: 'claude.json',
              provider: 'claude',
              disabled: false,
            },
          ],
        });
      }
      if (body.url === `${CLAUDE_USAGE_URL}?cedar_ember=1&skip_spend=1`) {
        return Response.json({
          status_code: 200,
          body: {
            seven_day: {
              utilization: Math.round((1 - claudeRemaining) * 100),
              resets_at: new Date(NOW + 5 * 24 * HOUR_MS).toISOString(),
            },
            five_hour: {
              utilization: 20,
              resets_at: new Date(NOW + 3 * HOUR_MS).toISOString(),
            },
          },
        });
      }
      return Response.json({ status_code: 404, body: '' });
    },
    { preconnect: () => {} }
  ) satisfies typeof fetch;

  const store = new QuotaStore(':memory:');
  cleanups.push(() => store.close());
  let clock = NOW;
  const collector = new QuotaCollector(store, {
    sources: manifest.sources,
    revision: 'synthetic-revision',
    fetcher,
    now: () => clock,
    agySnapshotPath: snapshotPath,
  });
  cleanups.push(() => collector.stop());

  const dashboard = (window: DashboardOptions['window'] = 'weekly') =>
    buildDashboard(
      store.listAccounts(),
      store.listSamples(clock - 24 * HOUR_MS, clock, window),
      {
        nowMs: clock,
        window,
        lookbackHours: 3,
        multiplier: 1,
        offsetDays: 0,
        reveal: false,
      },
      {
        historyStartedAtMs: store.firstSampleAtMs(),
        lastRefreshAtMs: collector.lastRefreshAtMs,
        nextRefreshAtMs: collector.nextRefreshAtMs,
        refreshing: false,
        issues: collector.issues,
        sources: collector.sources,
        windows: collector.windows,
      }
    );

  return {
    store,
    collector,
    snapshotPath,
    dashboard,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    setClaudeRemaining: (value: number) => {
      claudeRemaining = value;
    },
  };
}

describe('agy CLI /usage snapshot normalization and validation', () => {
  test('normalizes real agy /usage fixture and turns epoch-0 unused reset_time into null', () => {
    const normalized = normalizeAgyCliUsage(IN_USE_FIXTURE);
    expect(normalized).not.toBeNull();
    const { samples, windows } = quotaSamples('antigravity', 'acct-1', normalized, NOW);
    expect(samples).toEqual([
      {
        accountId: 'acct-1',
        window: 'five-hour',
        observedAtMs: NOW,
        remainingPercent: expect.closeTo(80.421066, 4),
        resetAtMs: Date.parse('2026-11-26T03:48:21Z'),
        periodHours: 5,
      },
      {
        accountId: 'acct-1',
        window: 'weekly',
        observedAtMs: NOW,
        remainingPercent: expect.closeTo(84.506774, 4),
        resetAtMs: Date.parse('2026-12-02T17:48:21Z'),
        periodHours: 168,
      },
    ]);
    // Claude and GPT unused buckets report 1970-01-01T00:00:00Z; resetAtMs must be null, never 0.
    const thirdParty = windows.filter((window) => laneOf('antigravity', window.id) === 'model');
    expect(thirdParty).toHaveLength(2);
    for (const lane of thirdParty) {
      expect(lane.remainingPercent).toBe(100);
      expect(lane.resetAtMs).toBeNull();
    }
  });

  test('rejects missing Gemini pool buckets, non-zero turns, bad fractions, and future timestamps', () => {
    const missing5h = structuredClone(IN_USE_FIXTURE) as {
      command: { data: { groups: { buckets: unknown[] }[] } };
    };
    missing5h.command.data.groups[0].buckets = [missing5h.command.data.groups[0].buckets[0]];
    expect(normalizeAgyCliUsage(missing5h)).toBeNull();

    const wrongTurns = { ...IN_USE_FIXTURE, num_turns: 1 };
    expect(normalizeAgyCliUsage(wrongTurns)).toBeNull();

    const failedStatus = { ...IN_USE_FIXTURE, status: 'ERROR' };
    expect(normalizeAgyCliUsage(failedStatus)).toBeNull();

    const futureEnvelope = makeEnvelope(NOW + 10 * 60_000);
    expect(parseAgySnapshotEnvelope(futureEnvelope, NOW)).toBeNull();

    expect(parseAgySnapshotEnvelope('{not json', NOW)).toBeNull();
  });
});

describe('QuotaCollector local agy file-drop ingest', () => {
  test('reuses existing disabled gemini-primary account, forecasts after 10m, and auto-disables after 30m silence', async () => {
    const f = collectorFixture();
    // Seed the existing disabled Gemini account as it sits in production SQLite today.
    const existingId = f.store.accountIdFor('gemini-primary', 'antigravity', 'legacy-index');
    f.store.recordInventory(
      'antigravity',
      [
        {
          id: existingId,
          instanceId: 'gemini-primary',
          provider: 'antigravity',
          name: 'antigravity-legacy.json',
          email: null,
          disabled: true,
          retired: false,
          lastSeenAtMs: NOW - 24 * HOUR_MS,
          lastErrorAtMs: null,
        },
      ],
      NOW - 24 * HOUR_MS,
      'gemini-primary'
    );
    f.store.recordPlan(existingId, 'g1-ultra-lite-tier', NOW - 24 * HOUR_MS, 0);
    f.store.recordPlan(existingId, 'g1-ultra-tier', NOW - 12 * HOUR_MS, NOW - 12 * HOUR_MS);

    // Drop snapshot #1 (85% weekly, 80% 5h).
    writeFileSync(f.snapshotPath, makeEnvelope(NOW, { geminiWeekly: 0.85, gemini5h: 0.8 }));
    await f.collector.refresh();

    // Reused the existing account ID (no duplicate) and flipped it live without touching plan history.
    const agAccounts = f.store.listAccounts().filter((a) => a.provider === 'antigravity');
    expect(agAccounts).toHaveLength(1);
    expect(agAccounts[0].id).toBe(existingId);
    expect(agAccounts[0].disabled).toBe(false);
    expect(agAccounts[0].planHistory).toEqual([
      { plan: 'g1-ultra-lite-tier', fromMs: 0 },
      { plan: 'g1-ultra-tier', fromMs: NOW - 12 * HOUR_MS },
    ]);

    const firstDash = f.dashboard('weekly');
    const firstGemini = firstDash.pools.find((p) => p.provider === 'antigravity')!;
    expect(firstGemini.capacityPoints).toBe(2000);
    expect(firstGemini.remainingPoints).toBeCloseTo(1700, 4);
    expect(firstGemini.accounts[0].windows.map((w) => w.id)).toEqual([
      'five-hour',
      'weekly',
      'claude-and-gpt-models:3p-5h',
      'claude-and-gpt-models:3p-weekly',
    ]);

    // Advance 10 minutes and drop snapshot #2 (83% weekly, 75% 5h) + refresh Claude so both have rates.
    f.advance(10 * 60_000);
    f.setClaudeRemaining(0.78);
    writeFileSync(f.snapshotPath, makeEnvelope(f.now(), { geminiWeekly: 0.83, gemini5h: 0.75 }));
    await f.collector.refresh();

    const liveDash = f.dashboard('weekly');
    const liveGemini = liveDash.pools.find((p) => p.provider === 'antigravity')!;
    expect(liveGemini.forecastState).toBe('ready');
    expect(liveGemini.remainingPoints).toBeCloseTo(1660, 4);
    expect(liveGemini.burnPointsPerHour).toBeCloseTo(240, 2);
    expect(liveDash.combined?.all.series?.forecastState).toBe('ready');

    // Advance 31 minutes without a new Gemini snapshot while Claude keeps refreshing.
    f.advance(AGY_ACTIVE_TTL_MS + 60_000);
    f.setClaudeRemaining(0.76);
    await f.collector.refresh();
    f.advance(10 * 60_000);
    f.setClaudeRemaining(0.74);
    await f.collector.refresh();

    // Gemini auto-disabled back to dormant history; combined "All" forecast stays ready for Claude.
    expect(f.store.listAccounts().find((a) => a.id === existingId)?.disabled).toBe(true);
    expect(f.collector.sources?.some((s) => s.instanceId === 'gemini-primary')).toBe(false);
    const dormantDash = f.dashboard('weekly');
    expect(dormantDash.combined?.all.series?.forecastState).toBe('ready');
    const dormantGemini = dormantDash.pools.find((p) => p.provider === 'antigravity')!;
    expect(dormantGemini.eligibleCount).toBe(0);
    expect(dormantGemini.recorded.length).toBeGreaterThan(0);
  });
});

describe('deploy/prox-agy-usage.sh safety gates', () => {
  function runHelper(fakeAgyScript: string, extraEnv: Record<string, string> = {}) {
    const dir = tempDir('prox-agy-sh-');
    const fakeBin = join(dir, 'fake-agy');
    writeFileSync(fakeBin, fakeAgyScript, { mode: 0o755 });
    chmodSync(fakeBin, 0o755);
    const dataDir = join(dir, 'data');
    const snapshotPath = join(dataDir, 'agy-usage.json');
    const stopFlag = join(dataDir, 'agy-usage.stopped');
    const result = spawnSync('bash', [SCRIPT_PATH], {
      env: {
        ...process.env,
        AGY_BIN: fakeBin,
        AGY_EXPECTED_VERSION: '1.5.17',
        AGY_DATA_DIR: dataDir,
        AGY_SNAPSHOT_PATH: snapshotPath,
        AGY_STOP_FLAG: stopFlag,
        ...extraEnv,
      },
      encoding: 'utf8',
    });
    return { result, snapshotPath, stopFlag, dataDir };
  }

  test('writes a valid 0600 snapshot atomically on matching version and clean JSON', () => {
    const fixtureJson = JSON.stringify(IN_USE_FIXTURE);
    const { result, snapshotPath, stopFlag } = runHelper(`#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "1.5.17"; exit 0; fi
cat <<'JSON'
${fixtureJson}
JSON
`);
    expect(result.status).toBe(0);
    expect(() => readFileSync(stopFlag)).toThrow();
    const parsed = parseAgySnapshotEnvelope(readFileSync(snapshotPath, 'utf8'), Date.now());
    expect(parsed).not.toBeNull();
    expect(parsed?.instanceId).toBe('gemini-primary');
    expect(parsed?.plan).toBe('g1-ultra-tier');
  });

  test('trips stop flag without calling /usage when agy version mismatches, and pauses subsequent runs', () => {
    const markerDir = tempDir('prox-agy-marker-');
    const calledFile = join(markerDir, 'called');
    const { result, stopFlag, dataDir, snapshotPath } = runHelper(`#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "1.6.0"; exit 0; fi
echo "called" > "${calledFile}"
exit 0
`);
    expect(result.status).toBe(1);
    expect(readFileSync(stopFlag, 'utf8')).toContain(
      'unexpected-agy-version:1.6.0:expected:1.5.17'
    );
    expect(() => readFileSync(calledFile)).toThrow();
    expect(() => readFileSync(snapshotPath)).toThrow();

    // Second run sees stop flag and exits 0 without touching agy at all.
    const second = spawnSync('bash', [SCRIPT_PATH], {
      env: {
        ...process.env,
        AGY_BIN: '/nonexistent-should-not-run',
        AGY_DATA_DIR: dataDir,
        AGY_SNAPSHOT_PATH: snapshotPath,
        AGY_STOP_FLAG: stopFlag,
      },
      encoding: 'utf8',
    });
    expect(second.status).toBe(0);
    expect(second.stderr).toContain('paused by stop flag');
  });

  test('trips stop flag and refuses to write if output contains an email address', () => {
    const withEmail = JSON.stringify({ ...IN_USE_FIXTURE, response: 'user@example.com' });
    const { result, snapshotPath, stopFlag } = runHelper(`#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "1.5.17"; exit 0; fi
cat <<'JSON'
${withEmail}
JSON
`);
    expect(result.status).toBe(1);
    expect(readFileSync(stopFlag, 'utf8')).toContain('validation-failed');
    expect(() => readFileSync(snapshotPath)).toThrow();
  });
});
