import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  isValidProviderId,
  type PoolProfile,
  type ProviderCatalogEntry,
} from '../../src/domain/providerCatalog';
import type {
  PoolProviderId,
  PoolProfileUpdate,
  PoolWindow,
  ResetProviderId,
} from '../../src/domain/quotaPool/types';
import {
  DAY_MS,
  RETIRED_ACCOUNT_NAME,
  RETIRED_GRACE_MS,
  type InventoryChange,
  type QuotaSample,
  type ResetEvent,
  type ResetReading,
  type StoredAccount,
  type StoredCatalogProvider,
} from './types';
import { legacyAccountId, sourceAccountId, type LegacySourceMapping } from './identity';
import { parsePoolProfile, type PoolProfileKey } from './poolProfiles';

type AccountRow = Omit<
  StoredAccount,
  'disabled' | 'retired' | 'retiredAtMs' | 'instanceId' | 'plan' | 'planObservedAtMs'
> & {
  disabled: number;
  retired: number;
  retiredAtMs: number | null;
};

const QUOTA_ACCOUNT_COLUMNS =
  'id, provider, name, email, disabled, retired, lastSeenAtMs, lastErrorAtMs, retiredAtMs';
const OBSERVATION_COLUMNS =
  'accountId, window, observedAtMs, remainingPercent, resetAtMs, periodHours';

function quotaAccountsTableSql(tableName: string, ifNotExists = false): string {
  return `
      CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
        name TEXT NOT NULL,
        email TEXT,
        disabled INTEGER NOT NULL CHECK (disabled IN (0, 1)),
        retired INTEGER NOT NULL CHECK (retired IN (0, 1)),
        lastSeenAtMs INTEGER NOT NULL,
        lastErrorAtMs INTEGER,
        retiredAtMs INTEGER
      );`;
}

/** Owns durable account metadata and normalized quota observations; never stores credentials. */
export class QuotaStore {
  private readonly db: Database;

  constructor(
    databasePath: string,
    private readonly now: () => number = Date.now
  ) {
    if (databasePath !== ':memory:') {
      const path = resolve(databasePath);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new Database(databasePath, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      -- WAL stays consistent with NORMAL; a power loss can drop the last commits, which the
      -- next collection re-reads. FULL fsyncs every commit on the thread serving analytics.
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      ${quotaAccountsTableSql('quota_accounts', true)}
      CREATE INDEX IF NOT EXISTS quota_accounts_provider ON quota_accounts(provider);
      CREATE TABLE IF NOT EXISTS quota_samples (
        accountId TEXT NOT NULL REFERENCES quota_accounts(id),
        window TEXT NOT NULL CHECK (window IN ('weekly', 'five-hour')),
        observedAtMs INTEGER NOT NULL,
        remainingPercent REAL CHECK (remainingPercent BETWEEN 0 AND 100),
        resetAtMs INTEGER,
        periodHours REAL CHECK (periodHours IS NULL OR periodHours > 0),
        PRIMARY KEY (accountId, window, observedAtMs)
      );
      CREATE INDEX IF NOT EXISTS quota_samples_time ON quota_samples(observedAtMs);
      CREATE INDEX IF NOT EXISTS quota_samples_window_time
        ON quota_samples(window, observedAtMs);
      CREATE TABLE IF NOT EXISTS quota_account_sources (
        accountId TEXT PRIMARY KEY REFERENCES quota_accounts(id),
        instanceId TEXT NOT NULL,
        sourceAccountId TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS quota_account_sources_instance
        ON quota_account_sources(instanceId);
      CREATE TABLE IF NOT EXISTS quota_legacy_sources (
        provider TEXT PRIMARY KEY CHECK (provider IN ('claude', 'codex')),
        instanceId TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_account_plans (
        accountId TEXT PRIMARY KEY REFERENCES quota_accounts(id),
        plan TEXT NOT NULL,
        observedAtMs INTEGER NOT NULL
      );
      -- Each plan an account has had, from when it was first seen; samples are weighted by the
      -- plan in force when they were recorded. A plan known before this table existed is in force
      -- from the start (fromMs 0).
      CREATE TABLE IF NOT EXISTS quota_plan_history (
        -- CASCADE: a build from before this table purges accounts without knowing it.
        accountId TEXT NOT NULL REFERENCES quota_accounts(id) ON DELETE CASCADE,
        plan TEXT NOT NULL,
        fromMs INTEGER NOT NULL,
        PRIMARY KEY (accountId, fromMs)
      );
      INSERT INTO quota_plan_history (accountId, plan, fromMs)
        SELECT p.accountId, p.plan, 0 FROM quota_account_plans p
        WHERE NOT EXISTS (SELECT 1 FROM quota_plan_history h WHERE h.accountId = p.accountId);
      CREATE TABLE IF NOT EXISTS quota_provider_catalog (
        instanceId TEXT NOT NULL,
        provider TEXT NOT NULL,
        displayName TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        quotaSupported INTEGER NOT NULL CHECK (quotaSupported IN (0, 1)),
        firstSeenAtMs INTEGER NOT NULL,
        lastSeenAtMs INTEGER NOT NULL,
        PRIMARY KEY (instanceId, provider)
      );
      CREATE TABLE IF NOT EXISTS quota_pool_profiles (
        instanceId TEXT NOT NULL,
        provider TEXT NOT NULL,
        weeklyWindowId TEXT,
        fiveHourWindowId TEXT,
        planUnitsJson TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updatedAtMs INTEGER NOT NULL,
        PRIMARY KEY (instanceId, provider)
      );
      -- Reset claims are user-requested spends and stay as history: no foreign key, no 30-day
      -- pruning, and an account purge leaves them (they hold opaque ids and readings only).
      CREATE TABLE IF NOT EXISTS quota_reset_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clientRequestId TEXT NOT NULL UNIQUE,
        accountId TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        kind TEXT NOT NULL,
        grantId TEXT,
        outcome TEXT NOT NULL,
        requestedAtMs INTEGER NOT NULL,
        settledAtMs INTEGER,
        cooldownCleared INTEGER CHECK (cooldownCleared IS NULL OR cooldownCleared IN (0, 1)),
        beforeJson TEXT,
        afterJson TEXT,
        -- SHA-256 of the Claude organization the claim was addressed to; never returned.
        organizationHash TEXT
      );
      CREATE INDEX IF NOT EXISTS quota_reset_events_time ON quota_reset_events(requestedAtMs);
      CREATE INDEX IF NOT EXISTS quota_reset_events_account
        ON quota_reset_events(accountId, requestedAtMs);
    `);
    this.db
      .transaction(() => {
        // A claim still pending when the process last stopped may have been sent: never failed.
        this.db
          .query("UPDATE quota_reset_events SET outcome = 'unknown' WHERE outcome = 'pending'")
          .run();
        const columns = this.db
          .query<{ name: string }, []>('PRAGMA table_info(quota_accounts)')
          .all();
        if (!columns.some((column) => column.name === 'retiredAtMs')) {
          this.db.exec('ALTER TABLE quota_accounts ADD COLUMN retiredAtMs INTEGER');
        }
        if (
          !this.db
            .query<{ name: string }, []>('PRAGMA table_info(quota_samples)')
            .all()
            .some((column) => column.name === 'bucketId')
        ) {
          this.db.exec('ALTER TABLE quota_samples ADD COLUMN bucketId TEXT');
        }
        // Accounts retired before this column existed scrub now and purge after the grace period.
        this.db
          .query(
            `UPDATE quota_accounts SET email = NULL, name = ?, retiredAtMs = COALESCE(retiredAtMs, ?)
             WHERE retired = 1`
          )
          .run(RETIRED_ACCOUNT_NAME, this.now());
      })
      .immediate();
    this.widenAccountProviders();
    // Stored generic samples retain the provider's bucket identity so a profile edit cannot
    // splice readings from two different buckets into one history or forecast.
    this.db.exec(`
      CREATE VIEW IF NOT EXISTS quota_current_samples AS
      SELECT s.*
      FROM quota_samples s
      LEFT JOIN quota_accounts a ON a.id = s.accountId
      LEFT JOIN quota_account_sources owner ON owner.accountId = s.accountId
      LEFT JOIN quota_pool_profiles p ON p.instanceId = owner.instanceId AND p.provider = a.provider
      WHERE s.bucketId IS NULL OR (p.enabled = 1 AND s.bucketId =
        CASE s.window WHEN 'weekly' THEN p.weeklyWindowId ELSE p.fiveHourWindowId END)
    `);
  }

  private needsProviderWidening(): boolean {
    const table = this.db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'quota_accounts'"
      )
      .get();
    return Boolean(table?.sql.match(/CHECK\s*\(\s*provider\s+IN\s*\(/i));
  }

  /**
   * Older databases enforce a fixed provider list. SQLite cannot alter a CHECK, so the
   * table is rebuilt once with every row, the
   * way https://sqlite.org/lang_altertable.html#otheralter describes: foreign keys off, copy,
   * drop, rename, index, then a foreign key check before commit. Migration eligibility is
   * re-checked inside the immediate transaction so concurrent starts cannot rebuild twice. Reset
   * events and legacy sources keep their claude/codex limit: Antigravity has neither.
   */
  private widenAccountProviders(): void {
    if (!this.needsProviderWidening()) return;
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.db
        .transaction(() => {
          if (!this.needsProviderWidening()) return;
          this.db.exec(`
            ${quotaAccountsTableSql('quota_accounts_widened')}
            INSERT INTO quota_accounts_widened (${QUOTA_ACCOUNT_COLUMNS})
              SELECT ${QUOTA_ACCOUNT_COLUMNS} FROM quota_accounts;
            DROP TABLE quota_accounts;
            ALTER TABLE quota_accounts_widened RENAME TO quota_accounts;
            CREATE INDEX quota_accounts_provider ON quota_accounts(provider);
          `);
          if (this.db.query('PRAGMA foreign_key_check').all().length)
            throw new Error('Quota account migration broke a reference');
        })
        .immediate();
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  listProviderCatalog(instanceId?: string): StoredCatalogProvider[] {
    return this.db
      .query<
        Omit<StoredCatalogProvider, 'quotaSupported'> & { quotaSupported: number },
        [string | null]
      >(
        `SELECT * FROM quota_provider_catalog WHERE (?1 IS NULL OR instanceId = ?1)
         ORDER BY instanceId, provider`
      )
      .all(instanceId ?? null)
      .map((row) => ({ ...row, quotaSupported: row.quotaSupported === 1 }));
  }

  /** Only a validated snapshot replaces the previous snapshot for this instance. */
  replaceProviderCatalog(
    instanceId: string,
    entries: readonly ProviderCatalogEntry[],
    nowMs: number
  ) {
    if (entries.some((entry) => !isValidProviderId(entry.id)))
      throw new Error('Invalid provider catalog');
    this.db
      .transaction(() => {
        this.db
          .query(
            `DELETE FROM quota_provider_catalog WHERE instanceId = ?
         AND provider NOT IN (SELECT value FROM json_each(?))`
          )
          .run(instanceId, JSON.stringify(entries.map((entry) => entry.id)));
        const upsert = this.db.query(`
        INSERT INTO quota_provider_catalog
          (instanceId, provider, displayName, lifecycle, quotaSupported, firstSeenAtMs, lastSeenAtMs)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(instanceId, provider) DO UPDATE SET displayName = excluded.displayName,
          lifecycle = excluded.lifecycle, quotaSupported = excluded.quotaSupported,
          lastSeenAtMs = excluded.lastSeenAtMs
      `);
        for (const entry of entries) {
          upsert.run(
            instanceId,
            entry.id,
            entry.displayName,
            entry.lifecycle,
            Number(entry.quota.supported),
            nowMs,
            nowMs
          );
        }
      })
      .immediate();
  }

  private profiles(key?: PoolProfileKey): PoolProfile[] {
    return this.db
      .query<
        Omit<PoolProfile, 'planUnits' | 'enabled'> & { planUnitsJson: string; enabled: number },
        [string | null, string | null]
      >(
        `
      SELECT * FROM quota_pool_profiles WHERE (?1 IS NULL OR (instanceId = ?1 AND provider = ?2))
      ORDER BY instanceId, provider
    `
      )
      .all(key?.instanceId ?? null, key?.provider ?? null)
      .map(({ planUnitsJson, enabled, ...row }) => ({
        ...row,
        enabled: enabled === 1,
        planUnits: JSON.parse(planUnitsJson) as PoolProfile['planUnits'],
      }));
  }

  listPoolProfiles(): PoolProfile[] {
    return this.profiles();
  }

  getPoolProfile(key: PoolProfileKey): PoolProfile | undefined {
    return this.profiles(key)[0];
  }

  putPoolProfile(input: PoolProfileUpdate, nowMs: number): PoolProfile {
    const profile = parsePoolProfile(input);
    if (!profile) throw new Error('Invalid quota pool profile');
    this.db
      .query(
        `
      INSERT INTO quota_pool_profiles
        (instanceId, provider, weeklyWindowId, fiveHourWindowId, planUnitsJson, enabled, updatedAtMs)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instanceId, provider) DO UPDATE SET weeklyWindowId = excluded.weeklyWindowId,
        fiveHourWindowId = excluded.fiveHourWindowId, planUnitsJson = excluded.planUnitsJson,
        enabled = excluded.enabled, updatedAtMs = excluded.updatedAtMs
    `
      )
      .run(
        profile.instanceId,
        profile.provider,
        profile.weeklyWindowId,
        profile.fiveHourWindowId,
        JSON.stringify(profile.planUnits),
        Number(profile.enabled),
        nowMs
      );
    return { ...profile, updatedAtMs: nowMs };
  }

  deletePoolProfile(key: PoolProfileKey): void {
    this.db
      .query('DELETE FROM quota_pool_profiles WHERE instanceId = ? AND provider = ?')
      .run(key.instanceId, key.provider);
  }

  listAccounts(): StoredAccount[] {
    const planHistory = new Map<string, { plan: string; fromMs: number }[]>();
    for (const { accountId, plan, fromMs } of this.db
      .query<{ accountId: string; plan: string; fromMs: number }, []>(
        'SELECT accountId, plan, fromMs FROM quota_plan_history ORDER BY accountId, fromMs'
      )
      .all()) {
      planHistory.set(accountId, [...(planHistory.get(accountId) ?? []), { plan, fromMs }]);
    }
    return this.db
      .query<
        AccountRow & {
          instanceId: string | null;
          sourceAccountId: string | null;
          plan: string | null;
          planObservedAtMs: number | null;
        },
        []
      >(
        `
        SELECT a.*, s.instanceId, s.sourceAccountId, p.plan, p.observedAtMs AS planObservedAtMs
        FROM quota_accounts a
        LEFT JOIN quota_account_sources s ON s.accountId = a.id
        LEFT JOIN quota_account_plans p ON p.accountId = a.id
        ORDER BY a.provider, a.id
      `
      )
      .all()
      .map(({ instanceId, sourceAccountId, plan, planObservedAtMs, retiredAtMs, ...row }) => ({
        ...row,
        ...(retiredAtMs === null ? {} : { retiredAtMs }),
        ...(instanceId === null ? {} : { instanceId }),
        ...(sourceAccountId === null ? {} : { sourceAccountId }),
        ...(plan === null || planObservedAtMs === null ? {} : { plan, planObservedAtMs }),
        ...(planHistory.has(row.id) ? { planHistory: planHistory.get(row.id) } : {}),
        disabled: row.disabled === 1,
        retired: row.retired === 1,
      }));
  }

  /** Add ownership only. Unknown legacy providers remain unresolved and untouched.
   * A conflicting attribution or alias collision rolls back the entire mapping.
   */
  migrateLegacySources(
    mappings: readonly LegacySourceMapping[],
    knownInstanceIds: readonly string[]
  ): void {
    const providers = new Set<PoolProviderId>();
    for (const mapping of mappings) {
      if (providers.has(mapping.provider) || !knownInstanceIds.includes(mapping.instanceId)) {
        throw new Error('Ambiguous or unknown legacy quota source');
      }
      providers.add(mapping.provider);
    }
    this.db
      .transaction(() => {
        for (const { provider, instanceId } of mappings) {
          const previous = this.db
            .query<{ instanceId: string }, [string]>(
              'SELECT instanceId FROM quota_legacy_sources WHERE provider = ?'
            )
            .get(provider);
          if (previous && previous.instanceId !== instanceId) {
            throw new Error('Conflicting legacy quota source');
          }
          this.db
            .query(
              `
          INSERT INTO quota_legacy_sources (provider, instanceId) VALUES (?, ?)
          ON CONFLICT(provider) DO NOTHING
        `
            )
            .run(provider, instanceId);
          const unresolved = this.db
            .query<{ id: string }, [string]>(
              `
          SELECT id FROM quota_accounts WHERE provider = ?
          AND NOT EXISTS (SELECT 1 FROM quota_account_sources WHERE accountId = id)
        `
            )
            .all(provider);
          const insert = this.db.query(`
          INSERT INTO quota_account_sources (accountId, instanceId, sourceAccountId)
          VALUES (?, ?, ?)
        `);
          for (const { id } of unresolved)
            insert.run(id, instanceId, sourceAccountId(instanceId, id));
        }
      })
      .immediate();
  }

  /** Resolve a source-local occurrence, including explicitly attributed legacy IDs. */
  accountIdFor(instanceId: string, provider: PoolProviderId, authIndex: string): string {
    if (!isValidProviderId(provider)) throw new Error('Invalid quota provider');
    const id = sourceAccountId(instanceId, legacyAccountId(provider, authIndex));
    return (
      this.db
        .query<{ accountId: string }, [string]>(
          'SELECT accountId FROM quota_account_sources WHERE sourceAccountId = ?'
        )
        .get(id)?.accountId ?? id
    );
  }

  listSamples(fromMs: number, toMs: number, window?: PoolWindow): QuotaSample[] {
    if (window !== undefined) {
      return this.db
        .query<QuotaSample, [number, number, PoolWindow]>(
          `
        SELECT ${OBSERVATION_COLUMNS} FROM quota_current_samples
        WHERE observedAtMs BETWEEN ? AND ? AND window = ?
        ORDER BY observedAtMs, accountId, window
      `
        )
        .all(fromMs, toMs, window);
    }
    return this.db
      .query<QuotaSample, [number, number]>(
        `
      SELECT ${OBSERVATION_COLUMNS} FROM quota_current_samples WHERE observedAtMs BETWEEN ? AND ?
      ORDER BY observedAtMs, accountId, window
    `
      )
      .all(fromMs, toMs);
  }

  /** Each account's newest sample per window, including explicit missing observations. */
  latestSamples(): QuotaSample[] {
    return this.db
      .query<QuotaSample, []>(
        `
      SELECT ${OBSERVATION_COLUMNS} FROM quota_current_samples s
      JOIN (
        SELECT accountId, window, MAX(observedAtMs) AS observedAtMs
        FROM quota_current_samples GROUP BY accountId, window
      ) latest USING (accountId, window, observedAtMs)
      ORDER BY accountId, window
    `
      )
      .all();
  }

  /** A generic account joins the window at its first sample under the selected mapping. */
  firstSampleTimes(window?: PoolWindow): Map<string, number> {
    return new Map(
      this.db
        .query<{ accountId: string; atMs: number }, [PoolWindow | null]>(
          `SELECT accountId, MIN(observedAtMs) AS atMs FROM quota_current_samples
           WHERE ?1 IS NULL OR bucketId IS NULL OR window = ?1 GROUP BY accountId`
        )
        .all(window ?? null)
        .map(({ accountId, atMs }) => [accountId, atMs])
    );
  }

  firstSampleAtMs(): number | null {
    return (
      this.db
        .query<{ atMs: number | null }, []>(
          'SELECT MIN(observedAtMs) AS atMs FROM quota_current_samples'
        )
        .get()?.atMs ?? null
    );
  }

  /** Call only with a validated, complete inventory for this instance/provider.
   * Omitting instanceId supports legacy fixtures and touches only unresolved rows.
   *
   * Accounts absent from it are retired in the same transaction: email and name are scrubbed
   * and `retiredAtMs` is stamped once. Absent accounts whose file name is in `deletedNames`
   * (the user deleted them by name and this inventory confirms they are gone) are purged now;
   * the name is matched before the scrub removes it. Returns the ids that changed.
   */
  recordInventory(
    provider: PoolProviderId,
    accounts: StoredAccount[],
    nowMs: number,
    instanceId?: string,
    deletedNames?: ReadonlySet<string>
  ): InventoryChange {
    if (!isValidProviderId(provider)) throw new Error('Invalid quota provider');
    const ids = new Set<string>();
    for (const account of accounts) {
      if (
        account.provider !== provider ||
        account.instanceId !== instanceId ||
        ids.has(account.id)
      ) {
        throw new Error('Invalid quota inventory');
      }
      ids.add(account.id);
    }
    const change: InventoryChange = { added: [], removed: [], purged: [] };
    this.db.transaction(() => {
      const scoped = this.db
        .query<{ id: string; name: string; retired: number; retiredAtMs: number | null }, string[]>(
          `
        SELECT id, name, retired, retiredAtMs FROM quota_accounts WHERE provider = ? AND
        ${
          instanceId === undefined
            ? 'NOT EXISTS (SELECT 1 FROM quota_account_sources WHERE accountId = id)'
            : 'id IN (SELECT accountId FROM quota_account_sources WHERE instanceId = ?)'
        }
      `
        )
        .all(...(instanceId === undefined ? [provider] : [provider, instanceId]));
      const existing = this.db.query<
        { provider: PoolProviderId; instanceId: string | null; retired: number },
        [string]
      >(`
        SELECT a.provider, a.retired, s.instanceId FROM quota_accounts a
        LEFT JOIN quota_account_sources s ON s.accountId = a.id WHERE a.id = ?
      `);
      const upsert = this.db.query(`
        INSERT INTO quota_accounts
          (id, provider, name, email, disabled, retired, lastSeenAtMs, lastErrorAtMs)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email,
          disabled = excluded.disabled, retired = 0, retiredAtMs = NULL,
          lastSeenAtMs = excluded.lastSeenAtMs
      `);
      for (const account of accounts) {
        const previous = existing.get(account.id);
        if (!previous || previous.retired === 1) change.added.push(account.id);
        if (
          previous &&
          (previous.provider !== provider || (previous.instanceId ?? undefined) !== instanceId)
        ) {
          throw new Error('Invalid quota identity');
        }
        if (
          !previous &&
          instanceId !== undefined &&
          !account.id.startsWith(`${instanceId}:${provider}:`)
        ) {
          throw new Error('Invalid quota identity');
        }
        upsert.run(
          account.id,
          provider,
          account.name,
          account.email,
          Number(account.disabled),
          nowMs,
          account.lastErrorAtMs
        );
        if (!previous && instanceId !== undefined) {
          this.db
            .query(
              `
            INSERT INTO quota_account_sources (accountId, instanceId, sourceAccountId)
            VALUES (?, ?, ?)
          `
            )
            .run(account.id, instanceId, account.id);
        }
      }
      const retire = this.db.query(
        'UPDATE quota_accounts SET retired = 1, email = NULL, name = ?, retiredAtMs = ? WHERE id = ?'
      );
      const stamp = this.db.query('UPDATE quota_accounts SET retiredAtMs = ? WHERE id = ?');
      for (const row of scoped) {
        if (ids.has(row.id)) continue;
        if (row.retired === 0) {
          if (deletedNames?.has(row.name)) {
            this.purgeInTransaction([row.id]);
            change.purged.push(row.id);
          } else {
            retire.run(RETIRED_ACCOUNT_NAME, nowMs, row.id);
            change.removed.push(row.id);
          }
        } else if (row.retiredAtMs === null) {
          stamp.run(nowMs, row.id);
        }
      }
    })();
    return change;
  }

  /** Remove accounts and everything referencing them. Children first: foreign keys are ON. */
  private purgeInTransaction(accountIds: readonly string[]): void {
    for (const table of ['quota_samples', 'quota_account_plans', 'quota_account_sources']) {
      const remove = this.db.query(`DELETE FROM ${table} WHERE accountId = ?`);
      for (const id of accountIds) remove.run(id);
    }
    const remove = this.db.query('DELETE FROM quota_accounts WHERE id = ?');
    for (const id of accountIds) remove.run(id);
  }

  /** Purge accounts that are already retired. A live account is never touched. Returns the ids. */
  purgeRetired(accountIds: readonly string[]): string[] {
    let purged: string[] = [];
    this.db.transaction(() => {
      const retired = this.db.query<{ id: string }, [string]>(
        'SELECT id FROM quota_accounts WHERE id = ? AND retired = 1'
      );
      purged = accountIds.filter((id) => Boolean(retired.get(id)));
      this.purgeInTransaction(purged);
    })();
    return purged;
  }

  /** True while the account exists and is in its inventory. */
  isLive(accountId: string): boolean {
    return Boolean(
      this.db
        .query<{ live: number }, [string]>(
          'SELECT 1 AS live FROM quota_accounts WHERE id = ? AND retired = 0'
        )
        .get(accountId)
    );
  }

  recordSamples(samples: QuotaSample[]): void {
    this.db.transaction(() => {
      const insert = this.db.query(`
        INSERT INTO quota_samples
          (accountId, window, observedAtMs, remainingPercent, resetAtMs, periodHours, bucketId)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(accountId, window, observedAtMs) DO NOTHING
      `);
      for (const sample of samples) {
        if (
          (sample.remainingPercent !== null && !Number.isFinite(sample.remainingPercent)) ||
          !Number.isSafeInteger(sample.observedAtMs) ||
          (sample.resetAtMs !== null && !Number.isSafeInteger(sample.resetAtMs)) ||
          (sample.periodHours !== null && !Number.isFinite(sample.periodHours))
        ) {
          throw new Error('Invalid quota sample');
        }
        insert.run(
          sample.accountId,
          sample.window,
          sample.observedAtMs,
          sample.remainingPercent,
          sample.resetAtMs,
          sample.periodHours,
          sample.bucketId ?? null
        );
        this.clearAccountError(sample.accountId, sample.observedAtMs);
      }
    })();
  }

  recordDiscoveredReading(
    accountId: string,
    observedAtMs: number,
    plan: string | null,
    samples: QuotaSample[]
  ): void {
    this.db.transaction(() => {
      this.recordSamples(samples);
      if (!samples.length) this.clearAccountError(accountId, observedAtMs);
      if (plan !== null) this.recordPlan(accountId, plan, observedAtMs);
      else {
        this.db.query('DELETE FROM quota_plan_history WHERE accountId = ?').run(accountId);
        this.db.query('DELETE FROM quota_account_plans WHERE accountId = ?').run(accountId);
      }
    })();
  }

  private clearAccountError(accountId: string, observedAtMs: number): void {
    this.db
      .query(
        `
      UPDATE quota_accounts SET lastErrorAtMs = NULL WHERE id = ? AND lastErrorAtMs <= ?
    `
      )
      .run(accountId, observedAtMs);
  }

  /**
   * Records the current plan, read at `nowMs`. A change also starts a history entry at `fromMs`,
   * the time of the reading it was read with, so that reading counts at the new plan and older
   * ones keep theirs.
   */
  recordPlan(accountId: string, plan: string, nowMs: number, fromMs = nowMs): void {
    this.db.transaction(() => {
      const latest = this.db
        .query<{ plan: string }, [string]>(
          'SELECT plan FROM quota_plan_history WHERE accountId = ? ORDER BY fromMs DESC LIMIT 1'
        )
        .get(accountId);
      if (latest?.plan !== plan) {
        // An account's first plan is in force from the start: its first samples precede the read.
        this.db
          .query(
            'INSERT OR REPLACE INTO quota_plan_history (accountId, plan, fromMs) VALUES (?, ?, ?)'
          )
          .run(accountId, plan, latest ? fromMs : 0);
      }
      this.db
        .query(
          `INSERT INTO quota_account_plans (accountId, plan, observedAtMs) VALUES (?, ?, ?)
         ON CONFLICT(accountId) DO UPDATE SET plan = excluded.plan, observedAtMs = excluded.observedAtMs`
        )
        .run(accountId, plan, nowMs);
    })();
  }

  markAccountError(id: string, nowMs: number): void {
    this.db.query('UPDATE quota_accounts SET lastErrorAtMs = ? WHERE id = ?').run(nowMs, id);
  }

  /** Drops old samples and purges accounts retired for the whole grace period; returns their ids. */
  prune(nowMs: number): string[] {
    let purged: string[] = [];
    this.db.transaction(() => {
      this.db.query('DELETE FROM quota_samples WHERE observedAtMs < ?').run(nowMs - 30 * DAY_MS);
      purged = this.db
        .query<{ id: string }, [number]>(
          'SELECT id FROM quota_accounts WHERE retired = 1 AND retiredAtMs <= ?'
        )
        .all(nowMs - RETIRED_GRACE_MS)
        .map(({ id }) => id);
      this.purgeInTransaction(purged);
    })();
    return purged;
  }

  /** Records a claim about to be sent, as `pending`. Throws when the request id was used before. */
  insertResetEvent(input: {
    accountId: string;
    provider: ResetProviderId;
    kind: string;
    grantId: string | null;
    clientRequestId: string;
    requestedAtMs: number;
    before: ResetReading | null;
    organizationHash?: string;
  }): ResetEvent {
    const { lastInsertRowid } = this.db
      .query(
        `INSERT INTO quota_reset_events
           (clientRequestId, accountId, provider, kind, grantId, outcome, requestedAtMs, beforeJson,
            organizationHash)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(
        input.clientRequestId,
        input.accountId,
        input.provider,
        input.kind,
        input.grantId,
        input.requestedAtMs,
        input.before ? JSON.stringify(input.before) : null,
        input.organizationHash ?? null
      );
    return this.resetEventById(Number(lastInsertRowid))!;
  }

  /** `settledAtMs` stays null while the outcome is `unknown`. */
  settleResetEvent(
    id: number,
    outcome: string,
    settledAtMs: number | null,
    cooldownCleared: boolean | null
  ): void {
    this.db
      .query(
        'UPDATE quota_reset_events SET outcome = ?, settledAtMs = ?, cooldownCleared = ? WHERE id = ?'
      )
      .run(outcome, settledAtMs, cooldownCleared === null ? null : Number(cooldownCleared), id);
  }

  setResetEventAfter(id: number, after: ResetReading | null): void {
    this.db
      .query('UPDATE quota_reset_events SET afterJson = ? WHERE id = ?')
      .run(after ? JSON.stringify(after) : null, id);
  }

  /** Which organization a Claude claim was addressed to, so a retry can be held to it. */
  resetEventOrganization(id: number): string | null {
    return (
      this.db
        .query<{ organizationHash: string | null }, [number]>(
          'SELECT organizationHash FROM quota_reset_events WHERE id = ?'
        )
        .get(id)?.organizationHash ?? null
    );
  }

  resetEventById(id: number): ResetEvent | null {
    return this.resetEvents('WHERE id = ?', [id])[0] ?? null;
  }

  resetEventByRequestId(clientRequestId: string): ResetEvent | null {
    return this.resetEvents('WHERE clientRequestId = ?', [clientRequestId])[0] ?? null;
  }

  /** The account's newest claim that may have been sent without an answer, from `sinceMs` on. */
  latestUnknownResetEvent(accountId: string, sinceMs: number): ResetEvent | null {
    return (
      this.resetEvents(
        "WHERE accountId = ? AND outcome = 'unknown' AND requestedAtMs >= ?",
        [accountId, sinceMs],
        1
      )[0] ?? null
    );
  }

  /** Newest first. */
  listResetEvents(filter: { provider?: ResetProviderId; sinceMs?: number; limit?: number }) {
    const where = ['1 = 1'];
    const params: (string | number)[] = [];
    if (filter.provider) {
      where.push('provider = ?');
      params.push(filter.provider);
    }
    if (filter.sinceMs !== undefined) {
      where.push('requestedAtMs >= ?');
      params.push(filter.sinceMs);
    }
    return this.resetEvents(`WHERE ${where.join(' AND ')}`, params, filter.limit ?? 500);
  }

  private resetEvents(where: string, params: (string | number)[], limit = 500): ResetEvent[] {
    return this.db
      .query<
        Omit<ResetEvent, 'cooldownCleared' | 'before' | 'after'> & {
          cooldownCleared: number | null;
          beforeJson: string | null;
          afterJson: string | null;
        },
        (string | number)[]
      >(
        `SELECT id, clientRequestId, accountId, provider, kind, grantId, outcome, requestedAtMs,
           settledAtMs, cooldownCleared, beforeJson, afterJson
         FROM quota_reset_events ${where} ORDER BY requestedAtMs DESC, id DESC LIMIT ${limit}`
      )
      .all(...params)
      .map(({ cooldownCleared, beforeJson, afterJson, ...row }) => ({
        ...row,
        cooldownCleared: cooldownCleared === null ? null : cooldownCleared === 1,
        before: beforeJson ? (JSON.parse(beforeJson) as ResetReading) : null,
        after: afterJson ? (JSON.parse(afterJson) as ResetReading) : null,
      }));
  }

  close(): void {
    this.db.close();
  }
}
