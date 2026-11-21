/**
 * ProxD provider catalog: `GET /v8/management/providers` (see src/domain/providerCatalog).
 */

import { parseProviderCatalog, type ProviderCatalog } from '@/domain/providerCatalog';
import type { ManagementTransport } from './sourceSession';

export type ProviderCatalogRead =
  { status: 'unchanged' } | { status: 'changed'; catalog: ProviderCatalog; etag: string | null };

const readEtag = (headers: unknown): string | null => {
  if (!headers || typeof headers !== 'object') return null;
  const value = (headers as Record<string, unknown>).etag;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

export function createProviderCatalogApi(client: Pick<ManagementTransport, 'getRaw'>) {
  return {
    /**
     * Conditional read: with the ETag already held the hub answers 304 when nothing changed.
     * An older ProxD without the route answers 404, which reaches the caller as an ApiError
     * with `status: 404`.
     */
    read: async (etag: string | null, signal?: AbortSignal): Promise<ProviderCatalogRead> => {
      const response = await client.getRaw('/providers', {
        headers: etag ? { 'If-None-Match': etag } : {},
        signal,
        validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
      });
      if (response.status === 304) return { status: 'unchanged' };
      const catalog = parseProviderCatalog(response.data);
      if (!catalog) throw new Error('Invalid provider catalog');
      return { status: 'changed', catalog, etag: readEtag(response.headers) };
    },
  };
}

export type ProviderCatalogApi = ReturnType<typeof createProviderCatalogApi>;
