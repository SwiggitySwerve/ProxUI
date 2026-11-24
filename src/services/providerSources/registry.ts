import { resolveConnectionSources } from '@/domain/providerSources/resolution';
import type {
  ResolvedSource,
  SourceDiscovery,
  SourceResolution,
} from '@/domain/providerSources/types';
import { validatedManagementBase } from '@/utils/connection';
import {
  SourceSessions,
  type SourceConnection,
  type SourceSession,
  type SourceTransportEvent,
} from '@/services/api/sourceSession';
import { fetchSourceDiscovery } from './discovery';

export interface SourceView {
  readonly source: ResolvedSource;
  readonly session: SourceSession | null;
  readonly status: 'ready' | 'authentication-required' | 'unauthorized';
  readonly version: string | null;
  readonly buildDate?: string | null;
  readonly supportsPlugin: boolean;
}
export interface SourceRegistrySnapshot {
  readonly status: 'disconnected' | 'loading' | 'ready' | 'error';
  readonly resolution: SourceResolution | null;
  readonly sources: readonly SourceView[];
}
const disconnected: SourceRegistrySnapshot = Object.freeze({
  status: 'disconnected',
  resolution: null,
  sources: [],
});
type Discover = (origin: string, signal: AbortSignal) => Promise<SourceDiscovery | null>;
/** How often a connected deployment re-reads `/prox/sources.json` for hubs added at run time. */
const DISCOVERY_POLL_MS = 60_000;

/** Owns authenticated source inventory; selection does not change source identity. */
export class SourceRegistry {
  private snapshot: SourceRegistrySnapshot = disconnected;
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private readonly sessions = new SourceSessions((event) => this.receive(event));
  private connections: SourceConnection[] = [];
  /** Set while connected through deployment discovery; what a later discovery is resolved with. */
  private deployment: { base: string; managementKey: string; appOrigin: string } | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly discover: Discover = fetchSourceDiscovery) {}
  getSnapshot = (): SourceRegistrySnapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(snapshot: SourceRegistrySnapshot) {
    this.snapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) listener();
  }
  reset(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.deployment = null;
    this.sessions.reset();
    this.connections = [];
    this.publish(disconnected);
  }
  /** A refresh begins: each hub proves the management key with one request before the rest. */
  armAuthProbes(): void {
    this.sessions.armAuthProbes();
  }
  /** Hubs that refused this session's management key; ProxUI no longer calls them. */
  deniedSources(): string[] {
    return this.sessions.deniedSources();
  }
  async connect(apiBase: string, managementKey: string, appOrigin: string): Promise<void> {
    this.reset();
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ status: 'loading', resolution: null, sources: [] });
    try {
      const base = validatedManagementBase(apiBase);
      const discovery =
        new URL(base).origin === appOrigin
          ? await this.discover(appOrigin, controller.signal)
          : null;
      if (controller.signal.aborted) return;
      const resolution = resolveConnectionSources(base, appOrigin, discovery);
      this.adopt(resolution, managementKey);
      if (resolution.mode === 'deployment') {
        this.deployment = { base, managementKey, appOrigin };
        this.pollTimer = setInterval(() => void this.refreshDiscovery(), DISCOVERY_POLL_MS);
      }
    } catch {
      if (!controller.signal.aborted) {
        this.sessions.reset();
        this.connections = [];
        this.publish({ status: 'error', resolution: null, sources: [] });
      }
    }
  }
  /**
   * Re-reads public discovery. A new revision adds and removes hubs; a hub whose route and scope
   * are unchanged keeps its session, so work in flight on it is not interrupted. A failed read, or
   * a discovery that no longer lists the hub this connection signed in to on the same route and
   * scope, changes nothing: the key was given for that binding, so a moved binding waits for the
   * next sign-in rather than having sessions created for it with this key.
   */
  refreshDiscovery(): Promise<boolean> {
    this.refreshing ??= this.readDiscovery().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  private async readDiscovery(): Promise<boolean> {
    const { controller, deployment } = this;
    if (!controller || !deployment) return false;
    try {
      const discovery = await this.discover(deployment.appOrigin, controller.signal);
      if (this.controller !== controller || controller.signal.aborted) return false;
      if (!discovery || discovery.revision === this.snapshot.resolution?.revision) return false;
      const resolution = resolveConnectionSources(deployment.base, deployment.appOrigin, discovery);
      if (resolution.mode !== 'deployment') return false;
      const binding = (resolved: SourceResolution | null) => {
        const source = resolved?.sources.find(
          (entry) => entry.instanceId === resolved.selectedInstanceId
        );
        return source && [source.instanceId, source.apiBase, source.authScope].join('\0');
      };
      if (binding(resolution) !== binding(this.snapshot.resolution)) return false;
      this.adopt(resolution, deployment.managementKey);
      return true;
    } catch {
      return false;
    }
  }
  /** Sessions are configured before anything is published; a rejected list changes nothing. */
  private adopt(resolution: SourceResolution, managementKey: string): void {
    const selected = resolution.sources.find(
      (source) => source.instanceId === resolution.selectedInstanceId
    )!;
    const before = new Map(this.snapshot.sources.map((view) => [view.source.instanceId, view]));
    const live = new Map(this.connections.map((entry) => [entry.instanceId, entry]));
    const connections = resolution.sources
      .filter((source) => source.authScope === selected.authScope)
      .map((source): SourceConnection => {
        const old = before.get(source.instanceId)?.source;
        const kept = live.get(source.instanceId);
        // The stored revision is what keeps this hub's session; a discovery revision alone,
        // which changes whenever any hub is added, must not restart it.
        return kept && old?.apiBase === source.apiBase && old.authScope === source.authScope
          ? kept
          : {
              instanceId: source.instanceId,
              apiBase: source.apiBase,
              managementKey,
              configurationRevision: `${resolution.revision}:${source.authScope}`,
            };
      });
    this.sessions.configure(connections);
    this.connections = connections;
    this.publish({
      status: 'ready',
      resolution,
      sources: resolution.sources.map((source): SourceView => {
        const session =
          source.authScope === selected.authScope
            ? this.sessions.captureSource(source.instanceId)
            : null;
        const old = before.get(source.instanceId);
        return old && old.session === session
          ? { ...old, source }
          : {
              source,
              session,
              status: session ? 'ready' : 'authentication-required',
              version: null,
              supportsPlugin: false,
            };
      }),
    });
  }
  private receive(event: SourceTransportEvent): void {
    const sources = this.snapshot.sources.map((view): SourceView => {
      if (view.session?.owner !== event.owner) return view;
      if (event.type === 'unauthorized')
        return view.status === 'unauthorized' ? view : { ...view, status: 'unauthorized' };
      if (event.type === 'server-version-update')
        return view.version === event.detail.version && view.buildDate === event.detail.buildDate
          ? view
          : { ...view, version: event.detail.version, buildDate: event.detail.buildDate };
      return view.supportsPlugin === event.detail.supportsPlugin
        ? view
        : { ...view, supportsPlugin: event.detail.supportsPlugin };
    });
    if (sources.some((source, index) => source !== this.snapshot.sources[index])) {
      this.publish({ ...this.snapshot, sources });
    }
  }
}
