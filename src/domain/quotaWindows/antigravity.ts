import type { AntigravityQuotaSummaryPayload } from '@/types';
import { decodeAntigravityQuotaGroups } from '@/utils/quota/builders';

export interface AntigravityQuotaWindow {
  id: string;
  label: string;
  labelKey: string;
  usedPercent: number;
  resetAtMs: number | null;
  periodHours: number | null;
}

/** Only buckets of the Gemini group feed the pool (user direction, 21 Nov 2026). */
const GEMINI_GROUP_ID = 'gemini-models';
const THIRD_PARTY_GROUP_ID = 'claude-and-gpt-models';
const GEMINI_POOL_IDS = new Map<string, 'five-hour' | 'weekly'>([
  ['gemini-5h', 'five-hour'],
  ['gemini-weekly', 'weekly'],
]);
const POOL_LABEL_KEYS = {
  'five-hour': 'antigravity_quota.five_hour_limit',
  weekly: 'antigravity_quota.weekly_limit',
} as const;
const THIRD_PARTY_LABEL_KEYS = new Map<string, string>([
  ['3p-5h', 'antigravity_quota.claude_gpt_five_hour_limit'],
  ['3p-weekly', 'antigravity_quota.claude_gpt_weekly_limit'],
]);

/**
 * Antigravity's `retrieveUserQuotaSummary` as quota windows for the history collector. Only the
 * Gemini group's recognized 5-hour and weekly buckets become the `five-hour` and `weekly` pool
 * windows; every other bucket is namespaced by its group (`${group.id}:${bucket.id}`, lane
 * `model`, `lanes.ts`) so it can never collide with a pool id.
 */
export function decodeAntigravityQuotaWindows(payload: AntigravityQuotaSummaryPayload): {
  windows: AntigravityQuotaWindow[];
  valid: boolean;
} {
  const { groups, valid } = decodeAntigravityQuotaGroups(payload);
  const windows = groups.flatMap((group) =>
    group.buckets.map((bucket) => {
      const pooled = group.id === GEMINI_GROUP_ID ? GEMINI_POOL_IDS.get(bucket.id) : undefined;
      const labelKey = pooled
        ? POOL_LABEL_KEYS[pooled]
        : group.id === THIRD_PARTY_GROUP_ID
          ? (THIRD_PARTY_LABEL_KEYS.get(bucket.id) ?? `${group.label} · ${bucket.label}`)
          : `${group.label} · ${bucket.label}`;
      return {
        id: pooled ?? `${group.id}:${bucket.id}`,
        label: `${group.label} · ${bucket.label}`,
        labelKey,
        usedPercent: (1 - bucket.remainingFraction) * 100,
        resetAtMs: bucket.resetAtMs ?? null,
        periodHours: bucket.periodHours ?? null,
      };
    })
  );
  return { windows, valid };
}
