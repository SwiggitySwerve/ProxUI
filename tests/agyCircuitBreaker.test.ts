import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHandler } from '../server/app';
import { QuotaCollector } from '../server/quota/collector';
import { QuotaStore } from '../server/quota/store';
import { validateSourceManifest } from '../src/domain/providerSources/manifest';

const IN_USE_FIXTURE = JSON.parse(
  readFileSync(resolve(import.meta.dir, 'fixtures/agy-usage/in-use.json'), 'utf8')
) as Record<string, unknown>;

const USAGE_SCRIPT = resolve(import.meta.dir, '../deploy/prox-agy-usage.sh');
const RECOVER_SCRIPT = resolve(import.meta.dir, '../deploy/prox-agy-recover.sh');
const BASE_NOW = Date.parse('2026-11-26T03:00:00Z');
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tempDir(prefix = 'prox-agy-cb-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setupHarness(options: {
  agyBehavior: string;
  timerEnabled?: boolean;
  timerActive?: boolean;
}) {
  const dir = tempDir();
  const dataDir = join(dir, 'data');
  const snapshotPath = join(dataDir, 'agy-usage.json');
  const stopFlag = join(dataDir, 'agy-usage.stopped');
  const eventsPath = join(dataDir, 'agy-events.jsonl');
  const fakeAgy = join(dir, 'fake-agy');
  const fakeSystemctl = join(dir, 'fake-systemctl');
  const fakeHook = join(dir, 'fake-hook');
  const systemctlLog = join(dir, 'systemctl.log');
  const hookLog = join(dir, 'hook.log');
  const agyCallLog = join(dir, 'agy-calls.log');

  writeFileSync(fakeAgy, options.agyBehavior.replaceAll('__CALL_LOG__', agyCallLog), {
    mode: 0o755,
  });
  chmodSync(fakeAgy, 0o755);

  const enabledOut = options.timerEnabled === false ? 'disabled' : 'enabled';
  const activeOut = options.timerActive === false ? 'inactive' : 'active';
  writeFileSync(
    fakeSystemctl,
    `#!/usr/bin/env bash
echo "$*" >> "${systemctlLog}"
if [[ "$*" == *"is-enabled"* ]]; then
  echo "${enabledOut}"
  [[ "${enabledOut}" == "enabled" ]] && exit 0 || exit 1
fi
if [[ "$*" == *"is-active"* ]]; then
  echo "${activeOut}"
  [[ "${activeOut}" == "active" ]] && exit 0 || exit 3
fi
exit 0
`,
    { mode: 0o755 }
  );
  chmodSync(fakeSystemctl, 0o755);

  writeFileSync(
    fakeHook,
    `#!/usr/bin/env bash
cat >> "${hookLog}"
`,
    { mode: 0o755 }
  );
  chmodSync(fakeHook, 0o755);

  const baseEnv = {
    ...process.env,
    AGY_BIN: fakeAgy,
    AGY_EXPECTED_VERSION: '1.5.17',
    AGY_DATA_DIR: dataDir,
    AGY_SNAPSHOT_PATH: snapshotPath,
    AGY_STOP_FLAG: stopFlag,
    AGY_EVENTS_PATH: eventsPath,
    AGY_EVENT_HOOK: fakeHook,
    AGY_USAGE_SCRIPT: USAGE_SCRIPT,
    AGY_RECOVERY_COOLDOWN_SEC: '1800',
    AGY_MAX_AUTO_RECOVERIES: '1',
    SYSTEMCTL_BIN: fakeSystemctl,
  };

  const runUsage = (nowMs: number, extra: Record<string, string> = {}) =>
    spawnSync('bash', [USAGE_SCRIPT], {
      env: { ...baseEnv, NOW_MS: String(nowMs), ...extra },
      encoding: 'utf8',
    });

  const runRecover = (nowMs: number, extra: Record<string, string> = {}) =>
    spawnSync('bash', [RECOVER_SCRIPT], {
      env: { ...baseEnv, NOW_MS: String(nowMs), ...extra },
      encoding: 'utf8',
    });

  const readEvents = () =>
    existsSync(eventsPath)
      ? readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];

  return {
    dir,
    dataDir,
    snapshotPath,
    stopFlag,
    eventsPath,
    fakeAgy,
    systemctlLog,
    hookLog,
    agyCallLog,
    runUsage,
    runRecover,
    readEvents,
  };
}

describe('prox-agy circuit breaker events, bounded recovery, and timer watchdog', () => {
  test('transient trip emits event, defers during cooldown, then probes once after cooldown and restarts timer on recovery', () => {
    const fixtureJson = JSON.stringify(IN_USE_FIXTURE);
    const modeFile = join(tempDir('prox-agy-mode-'), 'mode');
    writeFileSync(modeFile, 'fail');

    const h = setupHarness({
      agyBehavior: `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "1.5.17"; exit 0; fi
echo "usage" >> "__CALL_LOG__"
if [[ "$(cat "${modeFile}")" == "fail" ]]; then
  echo "network timeout" >&2
  exit 124
fi
cat <<'JSON'
${fixtureJson}
JSON
`,
    });

    // 1. Transient failure trips circuit breaker and emits event + invokes hook.
    const tripped = h.runUsage(BASE_NOW);
    expect(tripped.status).toBe(1);
    const flag = JSON.parse(readFileSync(h.stopFlag, 'utf8')) as Record<string, unknown>;
    expect(flag).toMatchObject({
      category: 'transient',
      reason: 'agy-command-failed',
      attempts: 0,
      trippedAtMs: BASE_NOW,
    });
    expect(h.readEvents().map((e) => e.event)).toEqual(['circuit_breaker_tripped']);
    expect(readFileSync(h.hookLog, 'utf8')).toContain('"circuit_breaker_tripped"');

    // 2. Immediate recovery check (before 30m cooldown) defers without probing agy.
    const early = h.runRecover(BASE_NOW + 60_000);
    expect(early.status).toBe(0);
    expect(readFileSync(h.agyCallLog, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(h.readEvents().map((e) => e.event)).toEqual([
      'circuit_breaker_tripped',
      'recovery_check_deferred',
    ]);

    // 3. Another early run deduplicates the deferred event (no spam).
    expect(h.runRecover(BASE_NOW + 120_000).status).toBe(0);
    expect(h.readEvents()).toHaveLength(2);

    // 4. After 30m cooldown with agy healthy again, recovery probe succeeds, clears flag, and restarts timer.
    writeFileSync(modeFile, 'ok');
    const recovered = h.runRecover(BASE_NOW + 1800 * 1000);
    expect(recovered.status).toBe(0);
    expect(existsSync(h.stopFlag)).toBe(false);
    expect(existsSync(h.snapshotPath)).toBe(true);
    expect(readFileSync(h.systemctlLog, 'utf8')).toContain('--user restart prox-agy-usage.timer');
    expect(h.readEvents().map((e) => e.event)).toEqual([
      'circuit_breaker_tripped',
      'recovery_check_deferred',
      'recovery_check_started',
      'recovery_check_passed',
      'timer_restarted',
    ]);
  });

  test('failed recovery probe escalates to hard_stop and never probes a second time', () => {
    const h = setupHarness({
      agyBehavior: `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "1.5.17"; exit 0; fi
echo "usage" >> "__CALL_LOG__"
echo "connection reset" >&2
exit 1
`,
    });

    expect(h.runUsage(BASE_NOW).status).toBe(1);
    // Cooldown elapses: single probe runs and fails -> escalates to hard_stop (attempts: 1).
    expect(h.runRecover(BASE_NOW + 1800 * 1000).status).toBe(0);
    const escalated = JSON.parse(readFileSync(h.stopFlag, 'utf8')) as Record<string, unknown>;
    expect(escalated).toMatchObject({ category: 'hard_stop', attempts: 1 });
    expect(readFileSync(h.agyCallLog, 'utf8').trim().split('\n')).toHaveLength(2);

    // Later recovery runs MUST NOT call agy again.
    expect(h.runRecover(BASE_NOW + 7200 * 1000).status).toBe(0);
    expect(readFileSync(h.agyCallLog, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(h.readEvents().map((e) => e.event)).toEqual([
      'circuit_breaker_tripped',
      'recovery_check_started',
      'recovery_check_escalated',
      'recovery_check_deferred',
    ]);
  });

  test('403 / TOS error classifies as hard_stop and recovery never auto-probes', () => {
    const h = setupHarness({
      agyBehavior: `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "1.5.17"; exit 0; fi
echo "usage" >> "__CALL_LOG__"
echo "HTTP 403 TOS_VIOLATION" >&2
exit 1
`,
    });

    expect(h.runUsage(BASE_NOW).status).toBe(1);
    const flag = JSON.parse(readFileSync(h.stopFlag, 'utf8')) as Record<string, unknown>;
    expect(flag).toMatchObject({ category: 'hard_stop', reason: 'auth-or-policy-error' });
    expect(h.runRecover(BASE_NOW + 7200 * 1000).status).toBe(0);
    // Still only the initial failing call — zero auto-probes.
    expect(readFileSync(h.agyCallLog, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(h.readEvents().map((e) => e.event)).toEqual([
      'circuit_breaker_tripped',
      'recovery_check_deferred',
    ]);
  });

  test('timer watchdog restarts an enabled-but-inactive timer when no stop flag is set', () => {
    const h = setupHarness({
      agyBehavior: '#!/usr/bin/env bash\nexit 0\n',
      timerEnabled: true,
      timerActive: false,
    });

    expect(h.runRecover(BASE_NOW).status).toBe(0);
    expect(readFileSync(h.systemctlLog, 'utf8')).toContain('--user restart prox-agy-usage.timer');
    expect(h.readEvents().map((e) => [e.event, e.reason])).toEqual([
      ['timer_restarted', 'timer-inactive-watchdog'],
    ]);
  });
});

describe('GET /v1/agy-status endpoint', () => {
  test('requires management auth and returns snapshot, circuitBreaker, and recentEvents', async () => {
    const dir = tempDir('prox-agy-api-');
    const keyFile = join(dir, 'management-key');
    const snapshotPath = join(dir, 'agy-usage.json');
    const stopFlagPath = join(dir, 'agy-usage.stopped');
    const eventsPath = join(dir, 'agy-events.jsonl');
    writeFileSync(keyFile, 'test-management-key');

    writeFileSync(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        instanceId: 'gemini-primary',
        sourceLabel: 'Gemini',
        observedAtMs: BASE_NOW - 60_000,
        agyVersion: '1.5.17',
        plan: 'g1-ultra-tier',
        usage: IN_USE_FIXTURE,
      })
    );
    writeFileSync(
      stopFlagPath,
      JSON.stringify({
        schemaVersion: 1,
        trippedAt: new Date(BASE_NOW).toISOString(),
        trippedAtMs: BASE_NOW,
        category: 'version_changed',
        reason: 'unexpected-agy-version:1.5.18:expected:1.5.17',
        attempts: 0,
        agyVersion: '1.5.18',
      })
    );
    writeFileSync(
      eventsPath,
      `${JSON.stringify({
        at: new Date(BASE_NOW).toISOString(),
        atMs: BASE_NOW,
        event: 'circuit_breaker_tripped',
        category: 'version_changed',
        reason: 'unexpected-agy-version:1.5.18:expected:1.5.17',
        agyVersion: '1.5.18',
      })}\n`
    );

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
    const store = new QuotaStore(':memory:');
    cleanups.push(() => store.close());
    const collector = new QuotaCollector(store, {
      sources: manifest.sources,
      revision: 'rev-1',
      fetcher: Object.assign(async () => Response.json({ files: [] }), {
        preconnect: () => {},
      }) as typeof fetch,
      now: () => BASE_NOW,
      agySnapshotPath: snapshotPath,
    });
    cleanups.push(() => collector.stop());
    await collector.ingestAgySnapshot();

    const handler = createHandler({ store, collector, keyFile, now: () => BASE_NOW });
    const unauth = await handler(new Request('http://127.0.0.1:18319/v1/agy-status'));
    expect(unauth.status).toBe(401);

    const authed = await handler(
      new Request('http://127.0.0.1:18319/v1/agy-status', {
        headers: { Authorization: 'Bearer test-management-key' },
      })
    );
    expect(authed.status).toBe(200);
    const body = (await authed.json()) as {
      snapshot: { instanceId: string; active: boolean; ageMs: number } | null;
      circuitBreaker: { open: boolean; category?: string; reason?: string };
      recentEvents: { event: string }[];
    };
    expect(body.snapshot).toMatchObject({
      instanceId: 'gemini-primary',
      active: true,
      ageMs: 60_000,
    });
    expect(body.circuitBreaker).toMatchObject({
      open: true,
      category: 'version_changed',
      reason: 'unexpected-agy-version:1.5.18:expected:1.5.17',
    });
    expect(body.recentEvents.map((e) => e.event)).toEqual(['circuit_breaker_tripped']);
  });
});
