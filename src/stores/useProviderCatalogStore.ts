/**
 * The one client-side copy of each hub's provider catalog (`GET /v8/management/providers`).
 *
 * One slice per source, keyed by instance id and stamped with the session that read it: a slice
 * whose owner is not the caller's session is never shown, and a response that lands after its
 * session was replaced (or after a newer read began) is dropped. An older ProxD without the route
 * answers 404; the slice then records `unsupported` and callers fall back to the static built-in
 * provider lists. A failed re-read keeps the last good catalog.
 */
import { create } from 'zustand';
import type { ProviderCatalog } from '@/domain/providerCatalog';
import { createProviderCatalogApi, type ProviderCatalogApi } from '@/services/api/providerCatalog';
import { sourceOwnerKey, type SourceOwner, type SourceSession } from '@/services/api/sourceSession';

export type ProviderCatalogStatus = 'loading' | 'ready' | 'unsupported' | 'error';

export interface SourceProviderCatalog {
  readonly ownerKey: string;
  readonly status: ProviderCatalogStatus;
  /** Last good catalog; kept through a failed re-read. */
  readonly catalog: ProviderCatalog | null;
  readonly etag: string | null;
  readonly error: string | null;
}

/** A session-like value: the owner to stamp, the signal that ends it, and its transport. */
export type CatalogSession = Pick<SourceSession, 'owner' | 'signal' | 'management'>;

export interface ProviderCatalogState {
  sources: Readonly<Record<string, SourceProviderCatalog>>;
  /** Loads once per session; `force` re-reads (conditionally, with the held ETag). */
  ensure(session: CatalogSession, options?: { force?: boolean }): Promise<void>;
  reset(): void;
}

const statusOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
const messageOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'Request failed';

export function createProviderCatalogStore(
  apiOf: (session: CatalogSession) => ProviderCatalogApi = (session) =>
    createProviderCatalogApi(session.management)
) {
  /** Latest request per instance; an older one landing late is ignored. */
  const latest = new Map<string, number>();
  /** The latest read per session (ownerKey), which a plain `ensure` joins. */
  const inflight = new Map<string, Promise<void>>();
  let seq = 0;

  return create<ProviderCatalogState>()((set, get) => ({
    sources: {},

    ensure: (session, options) => {
      const { instanceId } = session.owner;
      const ownerKey = sourceOwnerKey(session.owner);
      if (session.signal.aborted) return Promise.resolve();
      const current = get().sources[instanceId];
      const sameOwner = current?.ownerKey === ownerKey;
      if (!options?.force && sameOwner) {
        const pending = inflight.get(ownerKey);
        if (pending) return pending;
        // A read dropped with its caller's lease left `loading` behind: read again.
        if (current.status === 'ready' || current.status === 'unsupported') {
          return Promise.resolve();
        }
      }

      const request = ++seq;
      latest.set(instanceId, request);
      const known = sameOwner ? current : undefined;
      if (!known || known.status === 'error') {
        set((state) => ({
          sources: {
            ...state.sources,
            [instanceId]: {
              ownerKey,
              status: known?.catalog ? 'ready' : 'loading',
              catalog: known?.catalog ?? null,
              etag: known?.etag ?? null,
              error: null,
            },
          },
        }));
      }
      const isCurrent = () =>
        !session.signal.aborted &&
        latest.get(instanceId) === request &&
        // A reset or another session's read replaced this slice meanwhile.
        get().sources[instanceId]?.ownerKey === ownerKey;
      const commit = (next: Omit<SourceProviderCatalog, 'ownerKey'>) => {
        if (!isCurrent()) return;
        set((state) => ({
          sources: { ...state.sources, [instanceId]: { ownerKey, ...next } },
        }));
      };

      const etag = known?.catalog ? known.etag : null;
      const run: Promise<void> = apiOf(session)
        .read(etag, session.signal)
        .then(
          (result) => {
            const before = get().sources[instanceId];
            if (result.status === 'unchanged') {
              if (before?.catalog) commit({ ...before, status: 'ready', error: null });
              return;
            }
            commit({ status: 'ready', catalog: result.catalog, etag: result.etag, error: null });
          },
          (error: unknown) => {
            if (statusOf(error) === 404) {
              commit({ status: 'unsupported', catalog: null, etag: null, error: null });
              return;
            }
            const before = get().sources[instanceId];
            const kept = before?.ownerKey === ownerKey ? before.catalog : null;
            commit({
              status: kept ? 'ready' : 'error',
              catalog: kept,
              etag: kept ? (before?.etag ?? null) : null,
              error: messageOf(error),
            });
          }
        )
        .finally(() => {
          if (inflight.get(ownerKey) === run) inflight.delete(ownerKey);
        });
      inflight.set(ownerKey, run);
      return run;
    },

    reset: () => {
      latest.clear();
      inflight.clear();
      set({ sources: {} });
    },
  }));
}

export const useProviderCatalogStore = createProviderCatalogStore();

export function selectSourceCatalog(
  state: Pick<ProviderCatalogState, 'sources'>,
  owner: SourceOwner
): SourceProviderCatalog | undefined {
  const slice = state.sources[owner.instanceId];
  return slice?.ownerKey === sourceOwnerKey(owner) ? slice : undefined;
}

/** This owner's catalog slice, or undefined until it has been requested. */
export function useSourceProviderCatalog(
  owner: SourceOwner | null | undefined
): SourceProviderCatalog | undefined {
  return useProviderCatalogStore((state) =>
    owner ? selectSourceCatalog(state, owner) : undefined
  );
}

/** The catalog to build dynamic UI from, or null when callers should use their static lists. */
export const usableCatalog = (slice: SourceProviderCatalog | undefined): ProviderCatalog | null =>
  slice?.status === 'ready' ? slice.catalog : null;
