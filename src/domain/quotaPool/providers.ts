import type { BuiltInPoolProviderId, PoolProviderId } from './types';

export const BUILT_IN_POOL_PROVIDERS = [
  'claude',
  'codex',
  'antigravity',
] as const satisfies readonly BuiltInPoolProviderId[];

export function isBuiltInPoolProvider(provider: PoolProviderId): provider is BuiltInPoolProviderId {
  return BUILT_IN_POOL_PROVIDERS.some((builtIn) => builtIn === provider);
}

/** Keep the existing `all` selection distinct from a provider with that valid ID. */
export function poolProviderViewId(provider: PoolProviderId): string {
  return provider === 'all' ? ':all' : provider;
}
