import { useEffect } from 'react';
import { providerSources } from '@/stores/useProviderSources';
import {
  useProviderCatalogStore,
  useSourceProviderCatalog,
  type CatalogSession,
  type ProviderCatalogState,
  type SourceProviderCatalog,
} from '@/stores/useProviderCatalogStore';

let connected = false;

/**
 * The provider-catalog store, connected on first use: catalogs belong to the sessions that read
 * them, so a logout or reconnect (the registry leaving `ready`) drops every slice at once.
 */
export function providerCatalog(): ProviderCatalogState {
  if (!connected) {
    connected = true;
    let wasReady = providerSources.getSnapshot().status === 'ready';
    providerSources.subscribe(() => {
      const ready = providerSources.getSnapshot().status === 'ready';
      if (wasReady && !ready) useProviderCatalogStore.getState().reset();
      wasReady = ready;
    });
  }
  return useProviderCatalogStore.getState();
}

/** Re-read a hub's catalog after its credentials changed (sign-in, upload, delete). */
export const invalidateProviderCatalog = (session: CatalogSession): Promise<void> =>
  providerCatalog().ensure(session, { force: true });

/** Loads this session's catalog once and returns its slice (undefined until requested). */
export function useProviderCatalog(
  session: CatalogSession | null | undefined
): SourceProviderCatalog | undefined {
  useEffect(() => {
    if (session) void providerCatalog().ensure(session);
  }, [session]);
  return useSourceProviderCatalog(session?.owner);
}
