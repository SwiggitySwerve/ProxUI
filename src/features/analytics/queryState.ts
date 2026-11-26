import type { AnalyticsQuery, AnalyticsResponse } from '@/domain/analytics/types';
import {
  canonicalTimeZone,
  inRangeBucketTime,
  isKnownTimeZone,
  localDayStart,
  nextLocalDay,
  wholeHourZone,
} from '@/domain/analytics/timeZone';

export const ranges = ['1h', '24h', 'today', 'yesterday', '7d', '30d'] as const;
export type AnalyticsRange = (typeof ranges)[number];
/** Auto lets the range pick: hours up to a day, days beyond. The server buckets only hour or day. */
export const buckets = ['auto', 'hour', 'day'] as const;
export type AnalyticsBucket = (typeof buckets)[number];
const DAY = 86_400_000;
const rangeMilliseconds: Record<'1h' | '24h' | '7d' | '30d', number> = {
  '1h': 3_600_000,
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
};
export const analyticsTabs = [
  'overview',
  'tokens',
  'cost',
  'performance',
  'routing',
  'requests',
  'rates',
] as const;
export type AnalyticsTab = (typeof analyticsTabs)[number];
export function analyticsTab(value: string | null): AnalyticsTab {
  return analyticsTabs.find((tab) => tab === value) ?? 'overview';
}
export function rangeQuery(
  range: AnalyticsRange,
  now: number,
  bucket: AnalyticsBucket = 'auto',
  zone = 'UTC'
): AnalyticsQuery {
  const bounds = (inZone: string): [number, number] => {
    const midnight = localDayStart(inZone, now);
    return range === 'today'
      ? [midnight, now]
      : range === 'yesterday'
        ? [localDayStart(inZone, midnight - 1), midnight]
        : [now - rangeMilliseconds[range], now];
  };
  let effective = zone !== 'UTC' && isKnownTimeZone(zone) ? canonicalTimeZone(zone) : 'UTC';
  let [from, to] = bounds(effective);
  // Only fall back to UTC when this selected range contains a part-hour offset, and rebuild
  // Today/Yesterday bounds in UTC when it does.
  if (effective !== 'UTC' && !wholeHourZone(effective, from, to)) {
    effective = 'UTC';
    [from, to] = bounds('UTC');
  }
  return {
    from_ms: from,
    to_ms: to,
    time_zone: effective,
    granularity: bucket !== 'auto' ? bucket : range === '7d' || range === '30d' ? 'day' : 'hour',
    outcome: 'all',
    limit: 25,
  };
}
/** A provider named in the address: short, non-empty text only. */
export function addressProvider(value: string | null): string | undefined {
  const text = value?.trim();
  return text && text.length <= 200 ? text : undefined;
}
type Filters = Pick<AnalyticsQuery, 'provider' | 'model' | 'outcome' | 'search'>;
/** A provider in the address starts a fresh view: remembered model, search and outcome would silently narrow its totals. */
export function startingFilters(provider: string | undefined, saved: Partial<Filters>): Filters {
  return provider
    ? { provider, model: undefined, outcome: 'all', search: undefined }
    : {
        provider: saved.provider,
        model: saved.model,
        outcome: saved.outcome ?? 'all',
        search: saved.search,
      };
}
/** The window the answer covers: a served snapshot can end before the page's own clock. */
export function shownWindow(
  query: Pick<AnalyticsQuery, 'from_ms' | 'to_ms'>,
  data?: Partial<Pick<AnalyticsResponse, 'from_ms' | 'to_ms'>>
) {
  return { from_ms: data?.from_ms ?? query.from_ms, to_ms: data?.to_ms ?? query.to_ms };
}
export function withoutCursor(query: AnalyticsQuery): AnalyticsQuery {
  const filters = { ...query };
  delete filters.before_id;
  delete filters.before_ms;
  return filters;
}
/** A bucket click uses the same half-open UTC interval as the server's rollup. */
export function bucketQuery(query: AnalyticsQuery, bucket: number): AnalyticsQuery {
  // A local day can be 23 or 25 hours long; it ends at the next local midnight.
  const end =
    query.granularity === 'day' ? nextLocalDay(query.time_zone, bucket) : bucket + 3_600_000;
  return {
    ...withoutCursor(query),
    from_ms: inRangeBucketTime(bucket, query.from_ms),
    to_ms: Math.min(query.to_ms, end),
  };
}
/**
 * A chart bucket comes from the snapshot the server answered with, which can cover a slightly
 * different window than the page asked for; the drilldown clips to that served window.
 */
export function servedBucketQuery(
  query: AnalyticsQuery,
  data: Pick<AnalyticsResponse, 'from_ms' | 'to_ms' | 'granularity'>,
  bucket: number
): AnalyticsQuery {
  return bucketQuery(
    { ...query, ...shownWindow(query, data), granularity: data.granularity },
    bucket
  );
}
export function nextPageQuery(
  query: AnalyticsQuery,
  page: AnalyticsResponse['requests']
): AnalyticsQuery | null {
  if (!page.has_more || page.next_before_ms === null || page.next_before_id === null) return null;
  return { ...query, before_ms: page.next_before_ms, before_id: page.next_before_id };
}
