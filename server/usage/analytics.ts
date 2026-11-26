// Read-side analytics owner. Called inside a worker, with one immutable rate-book snapshot.
import type { Database } from 'bun:sqlite';
import type { AnalyticsMetrics, AnalyticsResponse } from '../../src/domain/analytics/types';
import { readAnalyticsGroups } from './rollupRead';
import { HOUR_MS, DAY_MS, type AggregateRow } from './aggregate';
import { sourceAttribution } from './parity';
import { analyticsCosts } from './analyticsPricing';
import { buildRateInventory } from './pricing';
import { queryFilter, requestPage, type CpampSearchReplay, type Dimension } from './search';
import { KNOWN_PROVIDERS } from './types';
import { inRangeBucketTime, zoneOffsetMinutes } from '../../src/domain/analytics/timeZone';
import type { RateBookState } from './rates';
import type { UsageAnalyticsQuery } from './validate';

export const COVERAGE_LIMITATIONS = [
  'Retained usage events are not a complete ingress or client-outcome ledger.',
  'Costs are estimated API-equivalent subtotals at current configured rates; unknown measurement presence and unsupported components remain partial.',
  'Legacy numeric zero is not proof of reported zero. Aggregate usage presence is unknown; missing measurements remain included in retained-event counts.',
  'Known supplementary records are excluded from counts, cost and detail because overlap is unresolved. Legacy record kinds remain unknown; counts are retained primary events, not verified inbound requests.',
  'Historical canonical output and effective tiers are not rewritten; older Gemini output may omit thoughts.',
  'Output speed uses output tokens divided by full execution duration. TTFT methods may differ; no generation-time subtraction is performed.',
];

function emptyMetrics(): AnalyticsMetrics {
  return {
    calls: 0,
    success_calls: 0,
    failure_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    uncached_input_tokens: 0,
    average_latency_ms: null,
    p95_latency_ms: null,
    p95_ttft_ms: null,
    cost: { usd: null, status: 'unavailable', reasons: ['no-retained-events'] },
  };
}
class Metrics {
  value = emptyMetrics();
  private latencySum = 0;
  private latencyCount = 0;
  add(row: AggregateRow) {
    const v = this.value;
    v.calls += row.calls;
    v.failure_calls += row.failures;
    v.success_calls += row.calls - row.failures;
    v.input_tokens += row.input_total;
    v.output_tokens += row.output_total;
    v.cache_read_tokens += row.cache_read;
    v.cache_creation_tokens += row.cache_write;
    v.reasoning_tokens += row.reasoning;
    v.total_tokens += row.total;
    v.uncached_input_tokens! += row.input_uncached;
    this.latencySum += row.latency_sum;
    this.latencyCount += row.latency_count;
    v.average_latency_ms = this.latencyCount ? this.latencySum / this.latencyCount : null;
  }
}
function group(map: Map<number, Metrics>, key: number): Metrics {
  let metrics = map.get(key);
  if (!metrics) {
    metrics = new Metrics();
    map.set(key, metrics);
  }
  return metrics;
}
/**
 * Each credential's most requests in flight at once among requests started in the range: at each
 * distinct start timestamp, all previously started requests still running (end > ts) plus every
 * request of that credential starting at ts. Equal-start events are batched so a missing or zero
 * duration counts once at its start without depending on row order.
 */
function readPeaks(
  db: Database,
  filter: ReturnType<typeof queryFilter>,
  check: () => void
): Map<string, { peak: number; at: number }> {
  const running = new Map<string, number[]>();
  const peaks = new Map<string, { peak: number; at: number }>();
  const batch = new Map<string, { count: number; ends: number[] }>();
  let currentTs: number | null = null;
  const flushBatch = () => {
    if (currentTs === null || batch.size === 0) return;
    const ts = currentTs;
    for (const [key, group] of batch) {
      const ends = running.get(key) ?? running.set(key, []).get(key)!;
      // Drop requests that finished at or before this start instant.
      while (ends.length && ends[0] <= ts) heapPop(ends);
      const inFlight = ends.length + group.count;
      const best = peaks.get(key);
      if (!best || inFlight > best.peak) peaks.set(key, { peak: inFlight, at: ts });
      for (const end of group.ends) heapPush(ends, end);
    }
    batch.clear();
  };
  let scanned = 0;
  for (const row of db
    .query<
      {
        ts_ms: number;
        latency_ms: number | null;
        instance_id: number | null;
        auth_index_id: number | null;
      },
      (number | string)[]
    >(
      `SELECT e.ts_ms, e.latency_ms, e.instance_id, e.auth_index_id
       FROM events e WHERE ${filter.sql} ORDER BY e.ts_ms`
    )
    .iterate(...filter.args)) {
    if ((++scanned & 4095) === 0) check();
    if (currentTs !== null && row.ts_ms !== currentTs) flushBatch();
    currentTs = row.ts_ms;
    const key = `${row.instance_id}:${row.auth_index_id}`;
    const entry = batch.get(key) ?? batch.set(key, { count: 0, ends: [] }).get(key)!;
    entry.count += 1;
    if (row.latency_ms !== null && row.latency_ms > 0) entry.ends.push(row.ts_ms + row.latency_ms);
  }
  flushBatch();
  return peaks;
}
function heapPush(heap: number[], value: number) {
  heap.push(value);
  for (let i = heap.length - 1; i > 0;) {
    const parent = (i - 1) >> 1;
    if (heap[parent] <= heap[i]) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    i = parent;
  }
}
function heapPop(heap: number[]) {
  const last = heap.pop()!;
  if (!heap.length) return;
  heap[0] = last;
  for (let i = 0; ;) {
    const left = 2 * i + 1;
    const right = left + 1;
    let smallest = i;
    if (left < heap.length && heap[left] < heap[smallest]) smallest = left;
    if (right < heap.length && heap[right] < heap[smallest]) smallest = right;
    if (smallest === i) break;
    [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
    i = smallest;
  }
}
interface AccountGroup {
  instance_id: number | null;
  auth_index_id: number | null;
  account_label_id: number | null;
  provider_id: number;
  model_id: number;
  calls: number;
  failures: number;
  total: number;
}
/**
 * Events per credential and per model × credential, from the events themselves: the hourly
 * rollups do not keep the credential. A credential is its source instance and the proxy's auth
 * index (the key that joins to quota and Auth Files); its label is the one most of its events
 * carried. Same filter as the totals, so the accounts add up to the summary.
 */
function readAccounts(
  db: Database,
  filter: ReturnType<typeof queryFilter>,
  names: Map<number, string>,
  check: () => void
): Pick<AnalyticsResponse, 'accounts' | 'routes'> {
  const peaks = readPeaks(db, filter, check);
  const name = (id: number | null) => (id === null ? null : (names.get(id) ?? null));
  const accounts = new Map<
    string,
    NonNullable<AnalyticsResponse['accounts']>[number] & { labels: Map<string, number> }
  >();
  const routes = new Map<string, NonNullable<AnalyticsResponse['routes']>[number]>();
  let scanned = 0;
  for (const row of db
    .query<AccountGroup, (number | string)[]>(
      `
    SELECT e.instance_id, e.auth_index_id, e.account_label_id, e.provider_id, e.model_id,
      count(*) AS calls, sum(e.failed) AS failures, sum(e.total) AS total
    FROM events e WHERE ${filter.sql}
    GROUP BY e.instance_id, e.auth_index_id, e.account_label_id, e.provider_id, e.model_id
  `
    )
    .iterate(...filter.args)) {
    if ((++scanned & 4095) === 0) check();
    const instance = name(row.instance_id);
    const authIndex = name(row.auth_index_id);
    const key = JSON.stringify([instance, authIndex]);
    const account =
      accounts.get(key) ??
      accounts
        .set(key, {
          instance,
          auth_index: authIndex,
          label: null,
          providers: [],
          calls: 0,
          failure_calls: 0,
          total_tokens: 0,
          peak_in_flight: peaks.get(`${row.instance_id}:${row.auth_index_id}`)?.peak ?? 0,
          peak_at_ms: peaks.get(`${row.instance_id}:${row.auth_index_id}`)?.at ?? null,
          labels: new Map(),
        })
        .get(key)!;
    account.calls += row.calls;
    account.failure_calls += row.failures;
    account.total_tokens += row.total;
    const provider = name(row.provider_id)!;
    if (!account.providers.includes(provider)) account.providers.push(provider);
    const label = name(row.account_label_id);
    if (label) account.labels.set(label, (account.labels.get(label) ?? 0) + row.calls);
    const model = name(row.model_id)!;
    const routeKey = JSON.stringify([model, instance, authIndex]);
    const route =
      routes.get(routeKey) ??
      routes
        .set(routeKey, {
          model,
          instance,
          auth_index: authIndex,
          calls: 0,
          failure_calls: 0,
          total_tokens: 0,
        })
        .get(routeKey)!;
    route.calls += row.calls;
    route.failure_calls += row.failures;
    route.total_tokens += row.total;
  }
  const order = (a: string | null, b: string | null) =>
    (a ?? '\uffff') < (b ?? '\uffff') ? -1 : (a ?? '\uffff') > (b ?? '\uffff') ? 1 : 0;
  return {
    accounts: [...accounts.values()]
      .map(({ labels, ...account }) => ({
        ...account,
        // The label most of its events carried; ties go to the alphabetically first.
        label: [...labels].sort((a, b) => b[1] - a[1] || order(a[0], b[0]))[0]?.[0] ?? null,
        providers: account.providers.sort(),
      }))
      .sort((a, b) => order(a.instance, b.instance) || order(a.auth_index, b.auth_index)),
    routes: [...routes.values()].sort(
      (a, b) =>
        order(a.model, b.model) ||
        order(a.instance, b.instance) ||
        order(a.auth_index, b.auth_index)
    ),
  };
}
export interface AnalyticsReadOptions {
  now?: () => number;
  /** Internal benchmark observer; never serialized in an AnalyticsResponse. */
  onPhase?: (phase: string) => void;
  /** Boundary observer for deterministic concurrent-write regression tests. Runs in the snapshot. */
  afterAggregate?: () => void;
  checkDeadline?: () => void;
  /** Parity replay only: search the way CPAMP's document does, plus the events only it matches. */
  cpampSearch?: CpampSearchReplay;
}
export function queryAnalytics(
  db: Database,
  q: UsageAnalyticsQuery,
  rates: RateBookState,
  options: AnalyticsReadOptions = {}
): AnalyticsResponse {
  const book = rates.book ?? { version: 1, models: {} };
  const check = options.checkDeadline ?? (() => {});
  // BEGIN DEFERRED pins the snapshot on the first SELECT, before any response component reads.
  return db
    .transaction((): AnalyticsResponse => {
      check();
      const dims = db.query<Dimension, []>('SELECT id, kind, value FROM dim').all();
      const names = new Map(dims.map((d) => [d.id, d.value]));
      const filter = queryFilter(db, q, dims, false, options.cpampSearch);
      const bucketSize = q.granularity === 'day' ? DAY_MS : HOUR_MS;
      const { rows, latency, coverageRows } = readAnalyticsGroups(
        db,
        q,
        filter,
        dims,
        book,
        bucketSize,
        (options.now ?? Date.now)(),
        check,
        options.onPhase,
        options.afterAggregate
      );
      check();
      const ranks = latency.result();
      check();
      options.onPhase?.('percentiles');
      const page = requestPage(db, q, filter, names, book);
      options.onPhase?.('request-page');
      const summary = new Metrics();
      const timeline = new Map<number, Metrics>();
      const models = new Map<number, Metrics>();
      const providers = new Map<number, Metrics>();
      // Each provider's share of each bucket, from the same rows as the totals, so it adds up.
      const providerBuckets = new Map<string, { provider: string; bucket: number; m: Metrics }>();
      const observed = new Map<string, { provider: string; id: string }>();
      for (const row of rows) {
        const model = names.get(row.model_id)!;
        const provider = names.get(row.provider_id)!;
        summary.add(row);
        group(timeline, row.bucket).add(row);
        group(models, row.model_id).add(row);
        group(providers, row.provider_id).add(row);
        const split = `${row.provider_id}:${row.bucket}`;
        if (!providerBuckets.has(split))
          providerBuckets.set(split, { provider, bucket: row.bucket, m: new Metrics() });
        providerBuckets.get(split)!.m.add(row);
        // Keyed by dimension ids: labels are reported text and could collide when joined.
        observed.set(`${row.provider_id}:${row.model_id}`, { provider, id: model });
      }
      // Hourly answers also total events by local weekday and hour (Sunday = 0) from timeline.
      let weekly: number[] | null = null;
      if (q.granularity === 'hour') {
        weekly = new Array<number>(7 * 24).fill(0);
        for (const [bucket, metrics] of timeline) {
          // A clipped first bucket uses its first instant inside [from_ms, to_ms) for local offset.
          const at = inRangeBucketTime(bucket, q.from_ms);
          const local = new Date(at + zoneOffsetMinutes(q.time_zone, at) * 60_000);
          weekly[local.getUTCDay() * 24 + local.getUTCHours()] += metrics.value.calls;
        }
      }

      const { accounts, routes } = readAccounts(db, filter, names, check);
      options.onPhase?.('accounts');
      const costs = analyticsCosts(rows, names, book, options.onPhase);
      summary.value.cost = costs.summary;
      for (const [id, metrics] of models) metrics.value.cost = costs.models.get(id)!;
      for (const [id, metrics] of providers) metrics.value.cost = costs.providers.get(id)!;
      for (const [id, metrics] of timeline) metrics.value.cost = costs.buckets.get(id)!;
      options.onPhase?.('pricing');

      // Selectors ignore provider/model/outcome, while retaining the range and search.
      let selectorRows: { model_id: number; provider_id: number }[];
      if (!q.model?.trim() && !q.provider?.trim() && q.outcome === 'all') selectorRows = rows;
      else {
        const selectors = queryFilter(db, q, dims, true, options.cpampSearch);
        selectorRows = db
          .query<{ model_id: number; provider_id: number }, (number | string)[]>(
            `SELECT DISTINCT e.model_id, e.provider_id FROM events e WHERE ${selectors.sql}`
          )
          .all(...selectors.args);
      }
      const selectorValues = (key: 'model_id' | 'provider_id') =>
        [...new Set(selectorRows.map((row) => names.get(row[key])!).filter(Boolean))].sort();
      const floor = Number(
        db
          .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'retention_floor_ms'")
          .get()?.value ?? 0
      );
      const gaps = db
        .query<{ instance: string; from_ms: number; to_ms: number }, [number, number]>(
          'SELECT instance, from_ms, to_ms FROM ingest_gaps WHERE from_ms < ? AND to_ms > ? AND filled_at_ms IS NULL ORDER BY from_ms, id'
        )
        .all(q.to_ms, q.from_ms);
      // Coverage describes the range, including rows hidden by filters or supplementary exclusion.
      const limitations = [...COVERAGE_LIMITATIONS];
      if (q.from_ms < floor)
        limitations.push(`History before retention_floor_ms ${floor} has been pruned.`);
      for (const gap of gaps)
        limitations.push(
          `Known collection gap for ${gap.instance}: [${gap.from_ms}, ${gap.to_ms}).`
        );
      if (coverageRows.some((row) => row.imported))
        limitations.push('History in this range was imported from CPAMP.');
      if (rates.error || !rates.book)
        limitations.push(
          'The rate book failed to load; the last good book is used when available.'
        );
      if (coverageRows.some((row) => !KNOWN_PROVIDERS.includes(names.get(row.provider_id)!)))
        limitations.push(
          'Records from an unknown provider are stored as reported; normalization is limited.'
        );
      limitations.push('records in flight during a collector or proxy restart may be absent');
      options.onPhase?.('coverage');
      // The providers each model came through, from the same provider × model pairs as rates.
      const providersOf = new Map<string, string[]>();
      for (const { provider, id } of observed.values())
        (providersOf.get(id) ?? providersOf.set(id, []).get(id)!).push(provider);
      const breakdown = (map: Map<number, Metrics>, ranked: typeof ranks.models) =>
        [...map]
          .map(([id, metrics]) => ({
            key: names.get(id)!,
            label: names.get(id) || 'Unknown',
            ...metrics.value,
            ...ranked.get(id),
          }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      check();
      return {
        schema_version: 1,
        generated_at_ms: (options.now ?? Date.now)(),
        from_ms: q.from_ms,
        to_ms: q.to_ms,
        granularity: q.granularity,
        coverage: {
          scope: 'retained-usage-events',
          raw_complete: q.from_ms >= floor && gaps.length === 0,
          limitations,
          source_attribution: sourceAttribution(page.items),
          price_basis: 'current-configured-rates',
          price_revision: rates.price_revision ?? '',
          timing_method: 'mixed-or-unknown',
        },
        summary: { ...summary.value, ...ranks.overall },
        timeline: [...timeline]
          .sort(([a], [b]) => a - b)
          .map(([bucket_ms, metrics]) => ({
            bucket_ms,
            ...metrics.value,
            ...ranks.buckets.get(bucket_ms),
          })),
        models: breakdown(models, ranks.models).map((model) => ({
          ...model,
          providers: [...(providersOf.get(model.key) ?? [])].sort(),
        })),
        accounts,
        routes,
        ...(weekly
          ? {
              weekly: weekly.map((calls, slot) => ({
                weekday: Math.floor(slot / 24),
                hour: slot % 24,
                calls,
              })),
            }
          : {}),
        provider_timeline: [...providerBuckets.values()]
          .sort((a, b) => a.bucket - b.bucket || (a.provider < b.provider ? -1 : 1))
          .map(({ provider, bucket, m }) => ({
            provider,
            bucket_ms: bucket,
            calls: m.value.calls,
            failure_calls: m.value.failure_calls,
            input_tokens: m.value.input_tokens,
            output_tokens: m.value.output_tokens,
            cache_read_tokens: m.value.cache_read_tokens,
            cache_creation_tokens: m.value.cache_creation_tokens,
            reasoning_tokens: m.value.reasoning_tokens,
            total_tokens: m.value.total_tokens,
          })),
        providers: breakdown(providers, ranks.providers),
        filter_options: {
          models: selectorValues('model_id'),
          providers: selectorValues('provider_id'),
        },
        requests: { ...page, total_count: summary.value.calls },
        rates: buildRateInventory(q.catalog, [...observed.values()], book),
      };
    })
    .deferred();
}
