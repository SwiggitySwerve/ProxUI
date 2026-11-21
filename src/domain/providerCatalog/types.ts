/**
 * Wire contract for ProxD `GET /v8/management/providers`, normalized v8 quota buckets,
 * and operator pool opt-in profiles. Shared across ProxUI browser and prox-history server.
 */

export const PROVIDER_CATALOG_SCHEMA_VERSION = 1 as const;

/** Lowercase provider slug: starts with alphanumeric, up to 64 ASCII chars. */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidProviderId(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_ID_RE.test(value);
}

/** Provider lifecycle derived authoritatively by ProxD from its credential store and plugin host. */
export type ProviderLifecycleState =
  | 'awaiting_auth'
  | 'active'
  | 'disabled'
  | 'needs_attention';

export type ProviderOriginKind = 'builtin' | 'plugin';
export type ProviderOAuthFlow = 'browser' | 'device';
export type ProviderQuotaReader = 'builtin' | 'plugin' | 'none';
export type NormalizedQuotaBucketScope = 'account' | 'model';

export interface ProviderCatalogCredentials {
  readonly total: number;
  readonly active: number;
  readonly disabled: number;
  readonly problem: number;
}

export interface ProviderCatalogOAuth {
  readonly flow: ProviderOAuthFlow;
  readonly aliases: readonly string[];
  readonly manualCallback: boolean;
  readonly webui: boolean;
  readonly domains: readonly string[];
}

export interface ProviderCatalogQuota {
  readonly supported: boolean;
  readonly reader: ProviderQuotaReader;
  readonly pluginId: string | null;
  readonly supportsReset: boolean;
}

export interface ProviderCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly source: ProviderOriginKind;
  readonly pluginId: string | null;
  readonly logo: string | null;
  readonly lifecycle: ProviderLifecycleState;
  readonly credentials: ProviderCatalogCredentials;
  readonly oauth: ProviderCatalogOAuth | null;
  readonly quota: ProviderCatalogQuota;
}

export interface ProviderCatalog {
  readonly schemaVersion: typeof PROVIDER_CATALOG_SCHEMA_VERSION;
  readonly instanceId: string | null;
  /** Providers this hub accepts for new credentials; null means open (all providers accepted). */
  readonly acceptedProviders: readonly string[] | null;
  readonly providers: readonly ProviderCatalogEntry[];
}

/** Extended normalized bucket fields returned by ProxD `POST /v8/management/quota/fetch`. */
export interface NormalizedQuotaBucketMeta {
  readonly id?: string;
  readonly periodSeconds?: number | null;
  readonly scope?: NormalizedQuotaBucketScope;
}

/** Operator opt-in configuration promoting a discovered provider into a Quota Management pool. */
export interface PoolProfile {
  readonly instanceId: string;
  readonly provider: string;
  readonly weeklyWindowId: string | null;
  readonly fiveHourWindowId: string | null;
  /** Base-plan unit weights keyed by normalized plan/tier id (1 unit = 100 pts). */
  readonly planUnits: Readonly<Record<string, number>>;
  readonly enabled: boolean;
  readonly updatedAtMs: number;
}
