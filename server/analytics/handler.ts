import { readFile } from 'node:fs/promises';
import { authorized } from '../app';
import { readJson } from '../http/readJson';
import { isRecord } from '../../src/utils/helpers';
import type { SourceManifest } from '../../src/domain/providerSources/types';
import { canonicalTimeZone, isKnownTimeZone } from '../../src/domain/analytics/timeZone';
import { rangeQuery } from '../../src/features/analytics/queryState';
import { readCatalogs, type Fetcher } from './catalog';
import { createSnapshotCache, type Outcome, type Query } from './cache';

const CATALOG_TTL = 5 * 60_000;

/** Canonical IANA zone for warming default views, or undefined when unset or invalid. */
export function parseWarmZone(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (trimmed.toUpperCase() === 'UTC') return 'UTC';
  return isKnownTimeZone(trimmed) ? canonicalTimeZone(trimmed) : undefined;
}

const QUERY_FIELDS = new Set([
  'from_ms',
  'to_ms',
  'time_zone',
  'granularity',
  'provider',
  'model',
  'outcome',
  'search',
  'limit',
  'before_ms',
  'before_id',
]);

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

/** Fixed authenticated bridge. prox-usage owns query validation, accounting and safe projections. */
export function createAnalyticsHandler(
  manifest: SourceManifest,
  fetcher: Fetcher = fetch,
  readKey = async (path: string) => (await readFile(path, 'utf8')).trim(),
  clock: () => number = Date.now,
  pinnedWarmZone?: string
) {
  const config = manifest.analytics;
  const fixedWarmZone = pinnedWarmZone ? parseWarmZone(pinnedWarmZone) : undefined;
  let activeWarmZone = fixedWarmZone ?? 'UTC';
  // The registered catalog rarely changes, so every view shares one read for a few minutes.
  // Only a catalog with every source ready is kept: a failed source is asked again next time.
  // Views that start together may each read it once; that is four small local requests.
  let catalogs: { at: number; value: Awaited<ReturnType<typeof readCatalogs>> } | undefined;
  async function catalogFor(signal: AbortSignal) {
    const now = clock();
    if (catalogs && now - catalogs.at < CATALOG_TTL) return catalogs.value;
    const value = await readCatalogs(manifest.sources, signal, fetcher, readKey);
    if (value.catalog_sources.every((source) => source.state === 'ready'))
      catalogs = { at: now, value };
    return value;
  }
  async function compute(query: Query): Promise<Outcome> {
    if (!config) return { ok: false, status: 503 };
    try {
      // Not tied to the caller's connection: the result is shared with later requests.
      const signal = AbortSignal.timeout(30000);
      const { catalog, catalog_sources } = await catalogFor(signal);
      const key = await readKey(config.adminKeyFile);
      if (!key) throw new Error('Missing dataset credential');
      signal.throwIfAborted();
      const response = await fetcher(
        new URL('/v0/management/monitoring/prox-analytics', config.upstreamOrigin),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...query, catalog }),
          signal,
          redirect: 'error',
        }
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return { ok: false, status: response.status === 400 ? 400 : 503 };
      }
      const result = await readJson(response.body, 32 * 1024 * 1024);
      if (
        !isRecord(result) ||
        result.schema_version !== 1 ||
        !isRecord(result.summary) ||
        !isRecord(result.coverage) ||
        !isRecord(result.requests) ||
        !Array.isArray(result.rates) ||
        !Array.isArray(result.timeline)
      )
        throw new Error('Invalid analytics response');
      return {
        ok: true,
        body: { ...result, catalog_sources },
        degraded: catalog_sources.some((source) => source.state !== 'ready'),
      };
    } catch {
      return { ok: false, status: 503 };
    }
  }
  const cache = createSnapshotCache(compute, clock, (now) => defaultViews(now, activeWarmZone));
  const handler = async (request: Request): Promise<Response> => {
    try {
      if (!authorized(request, manifest.history.managementKeyFile))
        return json({ error: 'Unauthorized' }, 401);
    } catch {
      return json({ error: 'Management authentication unavailable' }, 503);
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!config) return json({ error: 'Analytics is not configured for this deployment' }, 503);
    let query: Query;
    try {
      if (!request.body) throw new Error('Missing query');
      const body = await readJson(request.body, 16 * 1024);
      if (!isRecord(body) || Object.keys(body).some((key) => !QUERY_FIELDS.has(key)))
        throw new Error('Invalid query');
      query = body;
    } catch {
      return json({ error: 'Invalid analytics query' }, 400);
    }
    // Refresh asks for a recompute; every other load takes the warm snapshot.
    const fresh = request.headers.get('cache-control')?.includes('no-cache') ?? false;
    // A Refresh also re-reads the registered catalog, so a new registration shows at once.
    if (fresh) catalogs = undefined;
    const outcome = await cache.get(query, fresh);
    if (outcome.ok) {
      // Without an explicit PROX_ANALYTICS_TIME_ZONE, follow the live Analytics page's zone on
      // unfiltered queries (ignoring Dashboard provider polls, which always request UTC with limit 1).
      const isUnfilteredAnalyticsView =
        !query.provider &&
        !query.model &&
        !query.search &&
        (query.outcome === undefined || query.outcome === 'all') &&
        query.before_ms === undefined &&
        query.before_id === undefined &&
        query.limit !== 1;
      if (
        !fixedWarmZone &&
        isUnfilteredAnalyticsView &&
        typeof query.time_zone === 'string' &&
        (query.time_zone.toUpperCase() === 'UTC' || isKnownTimeZone(query.time_zone))
      ) {
        activeWarmZone = canonicalTimeZone(query.time_zone);
      }
      return json(outcome.body);
    }
    return json(
      {
        error:
          outcome.status === 400
            ? 'Invalid analytics filters'
            : 'Analytics data is temporarily unavailable',
      },
      outcome.status
    );
  };
  return Object.assign(handler, { warm: () => cache.warm() });
}

/**
 * The page's ranges, most used first, so a restart warms the views people open before the rest.
 * Any other live view (a filter, a provider, the dashboard's traffic view) stays warm for a day
 * after it is asked for.
 */
function defaultViews(now: number, zone = 'UTC'): Query[] {
  return [
    { ...rangeQuery('7d', now, 'hour', zone) },
    { ...rangeQuery('30d', now, 'auto', zone) },
    { ...rangeQuery('30d', now, 'hour', zone) },
    { ...rangeQuery('24h', now, 'auto', zone) },
    { ...rangeQuery('7d', now, 'auto', zone) },
    { ...rangeQuery('today', now, 'auto', zone) },
    { ...rangeQuery('1h', now, 'auto', zone) },
    { ...rangeQuery('yesterday', now, 'auto', zone) },
  ];
}
