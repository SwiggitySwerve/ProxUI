import type { PoolProfile } from '../../src/domain/providerCatalog';
import { isBuiltInPoolProvider } from '../../src/domain/quotaPool/providers';
import { maskIdentifier } from '../../src/domain/quotaPool/mask';
import type {
  AccountQuotaWindow,
  AwaitingAuthProvider,
  UnpooledProvider,
} from '../../src/domain/quotaPool/types';
import {
  STALE_MS,
  type QuotaSourceView,
  type StoredAccount,
  type StoredCatalogProvider,
} from './types';

export interface DiscoveryState {
  catalog: readonly StoredCatalogProvider[];
  poolProfiles: readonly PoolProfile[];
  observedAt?: ReadonlyMap<string, number>;
  planLabels?: ReadonlyMap<string, string>;
}

type DiscoveredPool = { profile: PoolProfile; displayName: string };

export function discoveredProviders(
  accounts: StoredAccount[],
  scopes: ReadonlyMap<string, QuotaSourceView>,
  discovery: DiscoveryState,
  windows: ReadonlyMap<string, readonly AccountQuotaWindow[]> | undefined,
  nowMs: number,
  reveal: boolean
) {
  const awaitingAuth: AwaitingAuthProvider[] = [];
  const unpooled: UnpooledProvider[] = [];
  const profilesBySource = new Map<string, Map<string, PoolProfile>>();
  for (const profile of discovery.poolProfiles) {
    const profiles = profilesBySource.get(profile.instanceId) ?? new Map<string, PoolProfile>();
    profiles.set(profile.provider, profile);
    profilesBySource.set(profile.instanceId, profiles);
  }
  const pooled = new Map<string, Map<string, DiscoveredPool>>();
  for (const entry of discovery.catalog) {
    const source = scopes.get(entry.instanceId);
    if (!source) continue;
    const members = accounts.filter(
      (account) =>
        !account.retired &&
        account.instanceId === entry.instanceId &&
        account.provider === entry.provider
    );
    const { instanceId, provider, displayName, quotaSupported } = entry;
    const identity = { instanceId, sourceLabel: source.sourceLabel, provider, displayName };
    if (entry.lifecycle === 'awaiting_auth' && members.length === 0) {
      awaitingAuth.push({ ...identity, quotaSupported });
      continue;
    }
    if (isBuiltInPoolProvider(provider) || !members.length) continue;
    const profile = profilesBySource.get(instanceId)?.get(provider);
    if (quotaSupported && profile?.enabled) {
      const sourcePools = pooled.get(instanceId) ?? new Map<string, DiscoveredPool>();
      sourcePools.set(provider, { profile, displayName });
      pooled.set(instanceId, sourcePools);
      continue;
    }
    unpooled.push({
      ...identity,
      accounts: members.map((account, index) => {
        const observedAtMs = discovery.observedAt?.get(account.id) ?? null;
        const status = account.disabled
          ? 'disabled'
          : !quotaSupported
            ? 'no-reader'
            : observedAtMs !== null && nowMs - observedAtMs <= STALE_MS
              ? 'ok'
              : account.lastErrorAtMs !== null && account.lastErrorAtMs >= (observedAtMs ?? 0)
                ? 'error'
                : 'stale';
        return {
          id: account.id,
          label: `${displayName} ${index + 1}`,
          identifier: reveal
            ? account.email || account.name
            : maskIdentifier(account.email || account.name),
          status,
          observedAtMs,
          planLabel: discovery.planLabels?.get(account.id) ?? account.plan ?? null,
          planType: account.plan ?? null,
          windows: windows?.get(account.id) ?? [],
        };
      }),
    });
  }
  return { awaitingAuth, unpooled, pooled };
}
