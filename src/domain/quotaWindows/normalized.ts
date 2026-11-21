import { containsControlCharacters, isRecord } from '../../utils/helpers';
import { normalizePlanType } from '../../utils/quota/parsers';
import { HOUR_MS } from '../../utils/time/durations';
import type { AccountQuotaWindow, PoolWindow } from '../quotaPool/types';
import type { NormalizedQuotaBucketScope, PoolProfile } from '../providerCatalog';

const POOL_PERIOD_HOURS: Readonly<Record<PoolWindow, number>> = { weekly: 168, 'five-hour': 5 };
export const POOL_WINDOWS = ['weekly', 'five-hour'] as const satisfies readonly PoolWindow[];

export function profileWindowId(
  profile: Pick<PoolProfile, 'weeklyWindowId' | 'fiveHourWindowId'>,
  lane: PoolWindow
): string | null {
  return lane === 'weekly' ? profile.weeklyWindowId : profile.fiveHourWindowId;
}

export function isQuotaWindowId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    value === value.trim() &&
    !containsControlCharacters(value)
  );
}

/** Legacy buckets can omit scope and duration. Reported metadata constrains the choice. */
export function canPoolWindow(window: AccountQuotaWindow, lane: PoolWindow): boolean {
  return (
    window.selectable !== false &&
    window.scope !== 'model' &&
    (window.periodHours == null || window.periodHours === POOL_PERIOD_HOURS[lane])
  );
}

export function preferredPoolWindow(windows: readonly AccountQuotaWindow[], lane: PoolWindow) {
  return windows.find(
    (window) => canPoolWindow(window, lane) && window.periodHours === POOL_PERIOD_HOURS[lane]
  );
}

const MAX_BUCKETS = 256;
const secondsPerHour = HOUR_MS / 1000;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isQuotaWindowId(trimmed) ? trimmed : null;
}

function parseBucket(raw: unknown) {
  if (!isRecord(raw)) throw new Error('Invalid normalized quota bucket');
  const fraction = raw.remainingFraction ?? raw.remaining_fraction;
  const seconds = raw.periodSeconds ?? raw.period_seconds;
  const reset = raw.resetTime ?? raw.reset_time;
  const { scope } = raw;
  if (
    typeof fraction !== 'number' ||
    !Number.isFinite(fraction) ||
    fraction < 0 ||
    fraction > 1 ||
    (seconds != null &&
      (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0)) ||
    (scope !== undefined && scope !== 'account' && scope !== 'model') ||
    (raw.id !== undefined && !isQuotaWindowId(raw.id)) ||
    (reset != null && typeof reset !== 'string')
  ) {
    throw new Error('Invalid normalized quota bucket');
  }
  const resetAtMs = reset ? Date.parse(reset) : null;
  if (resetAtMs !== null && !Number.isSafeInteger(resetAtMs)) {
    throw new Error('Invalid normalized quota reset time');
  }
  const id = raw.id ?? text(raw.window);
  return {
    id,
    label: text(raw.description) ?? text(raw.window) ?? id,
    scope: scope as NormalizedQuotaBucketScope | undefined,
    remainingPercent: fraction * 100,
    periodHours: seconds != null ? seconds / secondsPerHour : null,
    resetAtMs,
  };
}

/** Decode the ProxD pluginapi.QuotaFetchResponse shape, including pre-extension buckets. */
export function decodeNormalizedQuota(raw: unknown) {
  if (
    !isRecord(raw) ||
    (raw.groups !== undefined && (!Array.isArray(raw.groups) || raw.groups.length > MAX_BUCKETS))
  ) {
    throw new Error('Invalid normalized quota response');
  }
  const buckets: ReturnType<typeof parseBucket>[] = [];
  const counts = new Map<string, number>();
  for (const group of raw.groups ?? []) {
    if (
      !isRecord(group) ||
      (group.buckets !== undefined && !Array.isArray(group.buckets)) ||
      buckets.length + (group.buckets?.length ?? 0) > MAX_BUCKETS
    ) {
      throw new Error('Invalid normalized quota group');
    }
    for (const rawBucket of group.buckets ?? []) {
      const bucket = parseBucket(rawBucket);
      buckets.push(bucket);
      if (bucket.id) counts.set(bucket.id, (counts.get(bucket.id) ?? 0) + 1);
    }
  }
  const windows: AccountQuotaWindow[] = buckets.map(({ id, label, scope, ...bucket }, index) => {
    const selectable = id !== null && counts.get(id) === 1;
    let displayId = `display:${index}`;
    while (counts.has(displayId)) displayId += ':';
    return {
      ...bucket,
      id: selectable ? id : displayId,
      label: label ?? undefined,
      labelKey: 'quota_pool.remaining',
      ...(scope !== undefined ? { scope } : {}),
      ...(!selectable ? { selectable: false } : {}),
    };
  });
  const subscription = isRecord(raw.subscription) ? raw.subscription : {};
  const plan = normalizePlanType(
    text(subscription.tierId ?? subscription.tier_id) ?? text(subscription.plan)
  );
  const planLabel =
    text(subscription.tierName ?? subscription.tier_name) ?? text(subscription.plan) ?? plan;
  return { windows, plan, planLabel };
}
