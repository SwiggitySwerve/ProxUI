import { isRecord } from '@/utils/helpers';
import {
  PROVIDER_CATALOG_SCHEMA_VERSION,
  isValidProviderId,
  type ProviderCatalog,
  type ProviderCatalogCredentials,
  type ProviderCatalogEntry,
  type ProviderCatalogOAuth,
  type ProviderCatalogQuota,
  type ProviderLifecycleState,
  type ProviderOAuthFlow,
  type ProviderOriginKind,
  type ProviderQuotaReader,
} from './types';

const INSTANCE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const LIFECYCLES = new Set<ProviderLifecycleState>([
  'awaiting_auth',
  'active',
  'disabled',
  'needs_attention',
]);
const ORIGINS = new Set<ProviderOriginKind>(['builtin', 'plugin']);
const FLOWS = new Set<ProviderOAuthFlow>(['browser', 'device']);
const READERS = new Set<ProviderQuotaReader>(['builtin', 'plugin', 'none']);

function nonEmptyString(value: unknown, max = 256): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function nonNegInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringList(value: unknown, maxItems = 32): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    const s = nonEmptyString(item, 128);
    if (!s) return null;
    out.push(s);
  }
  return out;
}

function parseCredentials(raw: unknown): ProviderCatalogCredentials | null {
  if (!isRecord(raw)) return null;
  const total = nonNegInt(raw.total);
  const active = nonNegInt(raw.active);
  const disabled = nonNegInt(raw.disabled);
  const problem = nonNegInt(raw.problem);
  if (total === null || active === null || disabled === null || problem === null) return null;
  return { total, active, disabled, problem };
}

function parseOAuth(raw: unknown): ProviderCatalogOAuth | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) return undefined;
  const flow = raw.flow;
  if (typeof flow !== 'string' || !FLOWS.has(flow as ProviderOAuthFlow)) return undefined;
  const aliases = stringList(raw.aliases);
  const domains = stringList(raw.domains);
  const manualCallback = raw.manual_callback ?? raw.manualCallback;
  const webui = raw.webui;
  if (
    !aliases ||
    !domains ||
    typeof manualCallback !== 'boolean' ||
    typeof webui !== 'boolean'
  ) {
    return undefined;
  }
  return {
    flow: flow as ProviderOAuthFlow,
    aliases,
    manualCallback,
    webui,
    domains,
  };
}

function parseQuota(raw: unknown): ProviderCatalogQuota | null {
  if (!isRecord(raw)) return null;
  const supported = raw.supported;
  const reader = raw.reader;
  const supportsReset = raw.supports_reset ?? raw.supportsReset;
  const rawPluginId = raw.plugin_id ?? raw.pluginId;
  if (
    typeof supported !== 'boolean' ||
    typeof reader !== 'string' ||
    !READERS.has(reader as ProviderQuotaReader) ||
    typeof supportsReset !== 'boolean'
  ) {
    return null;
  }
  if (rawPluginId !== undefined && rawPluginId !== null && typeof rawPluginId !== 'string') {
    return null;
  }
  return {
    supported,
    reader: reader as ProviderQuotaReader,
    pluginId: nonEmptyString(rawPluginId, 128),
    supportsReset,
  };
}

function parseEntry(raw: unknown): ProviderCatalogEntry | null {
  if (!isRecord(raw)) return null;
  const id = raw.id;
  if (!isValidProviderId(id)) return null;
  const displayName = nonEmptyString(raw.display_name ?? raw.displayName, 128);
  const source = raw.source;
  const lifecycle = raw.lifecycle;
  if (
    !displayName ||
    typeof source !== 'string' ||
    !ORIGINS.has(source as ProviderOriginKind) ||
    typeof lifecycle !== 'string' ||
    !LIFECYCLES.has(lifecycle as ProviderLifecycleState)
  ) {
    return null;
  }
  const rawPluginId = raw.plugin_id ?? raw.pluginId;
  if (rawPluginId !== undefined && rawPluginId !== null && typeof rawPluginId !== 'string') {
    return null;
  }
  const rawLogo = raw.logo;
  if (rawLogo !== undefined && rawLogo !== null && typeof rawLogo !== 'string') {
    return null;
  }
  const credentials = parseCredentials(raw.credentials);
  const oauth = parseOAuth(raw.oauth);
  const quota = parseQuota(raw.quota);
  if (!credentials || oauth === undefined || !quota) return null;
  return {
    id,
    displayName,
    source: source as ProviderOriginKind,
    pluginId: nonEmptyString(rawPluginId, 128),
    logo: nonEmptyString(rawLogo, 512),
    lifecycle: lifecycle as ProviderLifecycleState,
    credentials,
    oauth,
    quota,
  };
}

/** Validates and normalizes a `GET /v8/management/providers` payload; returns null if malformed. */
export function parseProviderCatalog(raw: unknown): ProviderCatalog | null {
  if (!isRecord(raw)) return null;
  const schemaVersion = raw.schema_version ?? raw.schemaVersion;
  if (schemaVersion !== PROVIDER_CATALOG_SCHEMA_VERSION) return null;

  const rawInstanceId = raw.instance_id ?? raw.instanceId;
  let instanceId: string | null = null;
  if (rawInstanceId !== undefined && rawInstanceId !== null && rawInstanceId !== '') {
    if (typeof rawInstanceId !== 'string' || !INSTANCE_ID_RE.test(rawInstanceId)) return null;
    instanceId = rawInstanceId;
  }

  const rawAccepted = raw.accepted_providers ?? raw.acceptedProviders;
  let acceptedProviders: string[] | null = null;
  if (rawAccepted !== undefined && rawAccepted !== null) {
    if (!Array.isArray(rawAccepted) || rawAccepted.length > 128) return null;
    const seen = new Set<string>();
    const list: string[] = [];
    for (const item of rawAccepted) {
      if (!isValidProviderId(item) || seen.has(item)) return null;
      seen.add(item);
      list.push(item);
    }
    acceptedProviders = list;
  }

  if (!Array.isArray(raw.providers) || raw.providers.length > 256) return null;
  const seenIds = new Set<string>();
  const providers: ProviderCatalogEntry[] = [];
  for (const item of raw.providers) {
    const entry = parseEntry(item);
    if (!entry || seenIds.has(entry.id)) return null;
    seenIds.add(entry.id);
    providers.push(entry);
  }

  return {
    schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION,
    instanceId,
    acceptedProviders,
    providers,
  };
}
