import type { ProviderCatalog, ProviderCatalogEntry } from './types';

/**
 * Whether a provider a hub's catalog lists as waiting for its first credential belongs to that
 * source, so Auth Files and Quota Management show a waiting card for it there. One rule for both,
 * on exact provider ids (no display-alias folding): a hub that declares `accepted_providers` owns
 * exactly those; otherwise the source owns the providers the deployment declares for it, plus any
 * plugin provider no other source declares. How the first credential arrives (OAuth or upload) is
 * each surface's own concern.
 */
export function ownsWaitingProvider(
  catalog: Pick<ProviderCatalog, 'acceptedProviders'>,
  entry: ProviderCatalogEntry,
  declared: readonly string[],
  claimedElsewhere: readonly string[]
): boolean {
  if (catalog.acceptedProviders) return catalog.acceptedProviders.includes(entry.id);
  return (
    declared.includes(entry.id) ||
    (entry.source === 'plugin' && !claimedElsewhere.includes(entry.id))
  );
}
