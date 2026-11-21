import type { PoolProfile } from '../../src/domain/providerCatalog';
import type { AccountQuotaWindow } from '../../src/domain/quotaPool/types';
import {
  canPoolWindow,
  POOL_WINDOWS,
  profileWindowId,
} from '../../src/domain/quotaWindows/normalized';
import type { QuotaSample } from './types';

export function discoveredPoolSamples(
  accountId: string,
  observedAtMs: number,
  windows: readonly AccountQuotaWindow[],
  profile: PoolProfile | undefined
): QuotaSample[] {
  if (!profile?.enabled) return [];
  return POOL_WINDOWS.flatMap((window) => {
    const bucketId = profileWindowId(profile, window);
    if (bucketId === null) return [];
    const bucket = windows.find((entry) => entry.id === bucketId && canPoolWindow(entry, window));
    return [
      {
        accountId,
        observedAtMs,
        window,
        bucketId,
        remainingPercent: bucket?.remainingPercent ?? null,
        resetAtMs: bucket?.resetAtMs ?? null,
        periodHours: bucket?.periodHours ?? null,
      },
    ];
  });
}
