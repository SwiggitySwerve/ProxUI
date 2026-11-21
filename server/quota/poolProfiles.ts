import { isValidProviderId, type PoolProfile } from '../../src/domain/providerCatalog';
import { isBuiltInPoolProvider } from '../../src/domain/quotaPool/providers';
import type { AccountQuotaWindow, PoolProfileUpdate } from '../../src/domain/quotaPool/types';
import {
  canPoolWindow,
  isQuotaWindowId,
  POOL_WINDOWS,
  profileWindowId,
} from '../../src/domain/quotaWindows/normalized';
import { isRecord } from '../../src/utils/helpers';
import { POINTS_PER_UNIT } from './plans';

export type PoolProfileKey = Pick<PoolProfile, 'instanceId' | 'provider'>;

export function parsePoolProfileKey(value: unknown): PoolProfileKey | null {
  if (
    !isRecord(value) ||
    typeof value.instanceId !== 'string' ||
    !value.instanceId ||
    !isValidProviderId(value.provider) ||
    isBuiltInPoolProvider(value.provider)
  ) {
    return null;
  }
  return { instanceId: value.instanceId, provider: value.provider };
}

export function parsePoolProfile(value: unknown): PoolProfileUpdate | null {
  const key = parsePoolProfileKey(value);
  if (!key || !isRecord(value)) return null;
  const { weeklyWindowId, fiveHourWindowId, enabled, planUnits } = value;
  if (
    (weeklyWindowId !== null && !isQuotaWindowId(weeklyWindowId)) ||
    (fiveHourWindowId !== null && !isQuotaWindowId(fiveHourWindowId)) ||
    (weeklyWindowId !== null && weeklyWindowId === fiveHourWindowId) ||
    (enabled === true && weeklyWindowId === null && fiveHourWindowId === null) ||
    typeof enabled !== 'boolean' ||
    !isRecord(planUnits)
  ) {
    return null;
  }
  const entries = Object.entries(planUnits);
  if (
    entries.length > 128 ||
    entries.some(
      ([plan, units]) =>
        !isQuotaWindowId(plan) ||
        typeof units !== 'number' ||
        !Number.isFinite(units) ||
        units <= 0 ||
        units * POINTS_PER_UNIT > Number.MAX_SAFE_INTEGER
    )
  ) {
    return null;
  }
  return {
    ...key,
    weeklyWindowId,
    fiveHourWindowId,
    enabled,
    planUnits: Object.fromEntries(entries) as Record<string, number>,
  };
}

export function validProfileWindows(
  profile: PoolProfileUpdate,
  windows: readonly AccountQuotaWindow[],
  previous: PoolProfile | undefined
): boolean {
  return POOL_WINDOWS.every((lane) => {
    const id = profileWindowId(profile, lane);
    if (id === null) return true;
    const matches = windows.filter((window) => window.id === id);
    return matches.length
      ? matches.some((window) => canPoolWindow(window, lane))
      : previous !== undefined && profileWindowId(previous, lane) === id;
  });
}
