import type { ProviderCatalog, ProviderCatalogEntry } from '@/domain/providerCatalog';
import type { AuthFileItem } from '@/types';
import { normalizeOAuthProviderKey } from '@/utils/providerKeys';
import { providerGroupOf, type AuthFilesFilters } from './unifiedList';

/** The provider-tab / group key of a catalog entry, the same key `providerGroupOf` gives files. */
export const catalogProviderKey = (entry: ProviderCatalogEntry): string =>
  normalizeOAuthProviderKey(entry.id);

/**
 * Providers a hub's catalog lists as waiting for their first credential, which this source shows
 * as placeholder cards. A hub that declares `accepted_providers` gets exactly those. An open hub
 * (one that accepts everything) gets the providers the deployment declares for this source, plus
 * any provider its plugins add that no other source declares: a newly installed plugin shows up
 * on the hub that has it, while every built-in does not appear on every hub. A provider with any
 * credential file here is never a placeholder, so an added credential replaces it at once, before
 * the catalog is re-read. Nothing is shown until the files are known.
 */
export function awaitingAuthProviders(
  catalog: ProviderCatalog | null,
  ownedProviders: readonly string[] | undefined,
  files: readonly AuthFileItem[] | undefined,
  /** Providers other sources declare; an open hub's plugin entry for one belongs to them. */
  claimedElsewhere: readonly string[] = []
): ProviderCatalogEntry[] {
  if (!catalog || !files) return [];
  const keys = (list: readonly string[]) => new Set(list.map(normalizeOAuthProviderKey));
  const accepted = catalog.acceptedProviders ? keys(catalog.acceptedProviders) : null;
  const owned = keys(ownedProviders ?? []);
  const elsewhere = keys(claimedElsewhere);
  const present = new Set(files.map(providerGroupOf));
  return catalog.providers.filter((entry) => {
    const key = catalogProviderKey(entry);
    const ours = accepted
      ? accepted.has(key)
      : owned.has(key) || (entry.source === 'plugin' && !elsewhere.has(key));
    return entry.lifecycle === 'awaiting_auth' && ours && !present.has(key);
  });
}

/** A placeholder has no credential state, so only the provider tab and the search narrow it. */
export function awaitingMatchesFilters(
  entry: ProviderCatalogEntry,
  filters: Pick<AuthFilesFilters, 'provider' | 'statusFilterMode' | 'search'>
): boolean {
  const key = catalogProviderKey(entry);
  if (filters.provider !== 'all' && filters.provider !== key) return false;
  if (filters.statusFilterMode !== 'all') return false;
  const search = filters.search.trim().toLowerCase();
  return !search || key.includes(search) || entry.displayName.toLowerCase().includes(search);
}
