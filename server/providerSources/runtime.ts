import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseProviderCatalog } from '../../src/domain/providerCatalog/validate';
import { validateSourceManifest } from '../../src/domain/providerSources/manifest';
import { canonicalCredentialProvider } from '../../src/domain/providerSources/ownership';
import type {
  DeploymentSource,
  SourceDiscovery,
  SourceManifest,
} from '../../src/domain/providerSources/types';
import { MANAGEMENT_API_PREFIX } from '../../src/utils/constants';
import { readJson } from '../http/readJson';
import { describeSourceManifest } from './config';
import { generateSourceRoutes } from './routing';

const INSTANCE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_INSTANCES = 128;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_BYTES = 1024 * 1024;
const MAX_KEY_LENGTH = 8192;

/** One entry of ProxD's operator-owned `instances.json`, before any of it is trusted. */
export interface HubCandidate {
  readonly id: string;
  readonly provider: string;
  readonly upstreamOrigin: string;
  readonly label?: string;
  readonly authScope?: string;
  /** Set when the entry names its own key: such a hub must be added to the baked manifest. */
  readonly ownKey: boolean;
}

export interface InstancesFile {
  readonly candidates: readonly HubCandidate[];
  /** Entries that could not be read. `id` is null when the entry does not even name itself. */
  readonly rejected: readonly { readonly id: string | null; readonly reason: string }[];
}

export interface HubOutcome {
  readonly id: string;
  /** `base`: the baked manifest owns it. `retained`: kept from the last effective manifest. */
  readonly state: 'base' | 'admitted' | 'retained' | 'rejected' | 'removed';
  readonly reason?: string;
}

export interface ResolveOptions {
  /** The last effective manifest. Hubs it admitted survive a failed probe or an unreadable entry. */
  readonly previous?: SourceManifest | null;
  /** Host file holding the key the base manifest calls `history.managementKeyFile`. */
  readonly historyKeyFile: string;
  /** Passed to the route generator: where Nginx finds the discovery published with the routes. */
  readonly discoveryFile?: string;
  readonly fetcher?: typeof fetch;
  readonly readKey?: (hostPath: string) => Promise<string>;
  readonly timeoutMs?: number;
}

export interface EffectiveSources {
  readonly manifest: SourceManifest;
  readonly revision: string;
  readonly discovery: SourceDiscovery;
  readonly routes: string;
  readonly outcomes: readonly HubOutcome[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads `{ "instances": [...] }` (what ProxD ships) or a bare array. A document that is not a list
 * throws; one bad entry is set aside so it cannot take the other hubs with it. Field values are
 * only typed here: the manifest validator judges them when a candidate is about to be admitted.
 */
export function parseInstancesFile(raw: unknown): InstancesFile {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? raw.instances : null;
  if (!Array.isArray(list) || list.length > MAX_INSTANCES)
    throw new Error('Invalid instances file');
  const candidates: HubCandidate[] = [];
  const rejected: { id: string | null; reason: string }[] = [];
  const seen = new Map<string, number>();
  for (const entry of list) {
    const id = isRecord(entry) && typeof entry.id === 'string' ? entry.id : null;
    if (!isRecord(entry) || id === null || !INSTANCE_ID.test(id)) {
      rejected.push({ id: null, reason: 'Instance entry has no valid id' });
      continue;
    }
    seen.set(id, (seen.get(id) ?? 0) + 1);
    const optional = [entry.label, entry.auth_scope, entry.management_key_file];
    if (
      typeof entry.provider !== 'string' ||
      typeof entry.base_url !== 'string' ||
      optional.some((value) => value !== undefined && typeof value !== 'string')
    ) {
      rejected.push({ id, reason: 'Instance entry has a missing or mistyped field' });
    } else if (
      entry.management_path !== undefined &&
      entry.management_path !== MANAGEMENT_API_PREFIX
    ) {
      rejected.push({ id, reason: `management_path must be ${MANAGEMENT_API_PREFIX}` });
    } else {
      candidates.push({
        id,
        provider: entry.provider,
        upstreamOrigin: entry.base_url,
        label: entry.label as string | undefined,
        authScope: entry.auth_scope as string | undefined,
        ownKey: entry.management_key_file !== undefined,
      });
    }
  }
  // Two entries claiming one id leave no way to tell which the operator meant.
  const unique = (entry: { id: string | null }) => entry.id === null || seen.get(entry.id) === 1;
  return {
    candidates: candidates.filter(unique),
    rejected: [
      ...rejected.filter(unique),
      ...[...seen]
        .filter(([, count]) => count > 1)
        .map(([id]) => ({ id, reason: 'Instance id is listed more than once' })),
    ],
  };
}

type Probe =
  | { readonly state: 'verified'; readonly acceptedProviders: readonly string[] | null }
  | { readonly state: 'mismatch' | 'unreachable'; readonly reason: string };

/**
 * Asks the hub who it is, with the key it is expected to accept. `mismatch` is a hub that answered
 * and is not the claimed instance; everything short of an answer is `unreachable`.
 */
async function probeHub(
  origin: string,
  key: string,
  claimedId: string,
  fetcher: typeof fetch,
  timeoutMs: number
): Promise<Probe> {
  const get = async (path: string) => {
    const response = await fetcher(`${origin}${MANAGEMENT_API_PREFIX}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      return { status: response.status, body: null };
    }
    return { status: 200, body: await readJson(response.body, MAX_PROBE_BYTES) };
  };
  const mismatch: Probe = { state: 'mismatch', reason: 'Hub reports a different instance_id' };
  try {
    const catalog = await get('/providers');
    if (catalog.status === 200) {
      const parsed = parseProviderCatalog(catalog.body);
      if (!parsed) return { state: 'unreachable', reason: 'Hub sent a malformed provider catalog' };
      return parsed.instanceId === claimedId
        ? { state: 'verified', acceptedProviders: parsed.acceptedProviders }
        : mismatch;
    }
    // Only the provider catalog proves an identity; a hub without it is added to the baked manifest.
    return { state: 'unreachable', reason: `Hub answered ${catalog.status} to the catalog probe` };
  } catch {
    return { state: 'unreachable', reason: 'Hub did not answer the identity probe' };
  }
}

type Planned = Omit<DeploymentSource, 'providers'>;

/**
 * Decides the scope a candidate would use, before anything is sent to it. Run-time admission takes
 * only loopback hubs that accept the shared management key: a remote hub, or one with its own key,
 * needs transport and origin isolation decided by an operator, so it goes in the baked manifest.
 */
function planCandidate(base: SourceManifest, candidate: HubCandidate): Planned | string {
  let url: URL;
  try {
    url = new URL(candidate.upstreamOrigin);
  } catch {
    return 'base_url is not a URL';
  }
  if (url.origin !== candidate.upstreamOrigin) return 'base_url must be a bare HTTP(S) origin';
  const source = {
    instanceId: candidate.id,
    label: candidate.label ?? candidate.id,
    // The route names the binding, not just the hub: a hub re-added at another address gets a
    // new route, so a browser session opened on the old one can never reach the new upstream.
    publicBasePath: `/${candidate.id}-${createHash('sha256').update(candidate.upstreamOrigin).digest('hex').slice(0, 8)}`,
    aliases: [],
    upstreamOrigin: candidate.upstreamOrigin,
  };
  if (candidate.ownKey || !LOOPBACK_HOSTS.has(url.hostname))
    return 'Only loopback hubs on the shared key are admitted at run time; add this hub to provider-sources.json';
  // The probe proves this hub accepts the shared key, which is what sharing the scope asserts.
  const authScope =
    candidate.authScope ??
    base.sources.find((entry) => entry.managementKeyFile === base.history.managementKeyFile)
      ?.authScope;
  if (!authScope) return 'No baked source shares the history key; declare auth_scope';
  return { ...source, authScope, managementKeyFile: base.history.managementKeyFile };
}

/** Why `source` cannot join `sources`, or null. Sources already present always win a conflict. */
function conflict(
  base: SourceManifest,
  sources: readonly DeploymentSource[],
  source: DeploymentSource
): string | null {
  // The browser sends one management key to every route of a scope.
  if (
    sources.some(
      (entry) =>
        entry.authScope === source.authScope && entry.managementKeyFile !== source.managementKeyFile
    )
  )
    return 'auth_scope is already used with a different management key';
  try {
    validateSourceManifest({ ...base, sources: [...sources, source] });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid source';
  }
}

/**
 * Merges the baked manifest with the hubs `instances.json` lists. Baked sources are never changed
 * or displaced. A candidate joins only after it proves, with the key it is expected to accept, that
 * it is the instance it is listed as. A hub admitted earlier leaves only when the operator removes
 * its entry or another instance answers at its address; an outage or a bad edit keeps it.
 */
export async function resolveEffectiveManifest(
  base: SourceManifest,
  instances: InstancesFile,
  options: ResolveOptions
): Promise<EffectiveSources> {
  const fetcher = options.fetcher ?? fetch;
  const readKey = options.readKey ?? ((path: string) => readFile(path, 'utf8'));
  const baseIds = new Set(base.sources.map((source) => source.instanceId));
  const prior = new Map(
    (options.previous?.sources ?? [])
      .filter((source) => !baseIds.has(source.instanceId))
      .map((source) => [source.instanceId, source] as const)
  );
  const sources: DeploymentSource[] = [...base.sources];
  const outcomes: HubOutcome[] = [];
  const fail = (id: string, reason: string, retire = false) => {
    const kept = retire ? undefined : prior.get(id);
    if (kept && conflict(base, sources, kept) === null) {
      sources.push(kept);
      outcomes.push({ id, state: 'retained', reason });
    } else outcomes.push({ id, state: 'rejected', reason });
  };

  // Probe concurrently; admit in order afterwards so ownership does not depend on timing.
  const probed = await Promise.all(
    instances.candidates
      .filter((candidate) => !baseIds.has(candidate.id))
      .map(async (candidate) => {
        const plan = planCandidate(base, candidate);
        if (typeof plan === 'string') return { candidate, failure: plan };
        const failure = conflict(base, base.sources, plan);
        if (failure) return { candidate, failure };
        let key: string;
        try {
          key = (await readKey(options.historyKeyFile)).trim();
        } catch {
          key = '';
        }
        if (!key || key.length > MAX_KEY_LENGTH)
          return { candidate, failure: 'Management key file is unreadable' };
        const probe = await probeHub(
          plan.upstreamOrigin,
          key,
          candidate.id,
          fetcher,
          options.timeoutMs ?? PROBE_TIMEOUT_MS
        );
        return { candidate, plan, probe };
      })
  );

  // Hubs that are already members keep their place and their providers ahead of newcomers.
  const listed = new Set(instances.candidates.map((candidate) => candidate.id));
  const unreadable = instances.rejected.some((entry) => entry.id === null);
  for (const entry of instances.rejected) {
    if (entry.id === null || baseIds.has(entry.id)) continue;
    listed.add(entry.id);
    fail(entry.id, entry.reason);
  }
  for (const id of prior.keys()) {
    if (listed.has(id)) continue;
    // An entry that does not name itself may be this hub's.
    if (unreadable) fail(id, 'instances.json has an unreadable entry');
    else outcomes.push({ id, state: 'removed' });
  }
  for (const id of listed) if (baseIds.has(id)) outcomes.push({ id, state: 'base' });
  // Members that failed keep their last-known-good place first, so a healthy hub cannot take a
  // provider from one that is only offline; then healthy members, then newcomers.
  for (const { candidate, failure, plan, probe } of probed) {
    if (failure !== undefined) fail(candidate.id, failure);
    else if (probe.state !== 'verified')
      // Another instance answering at the address this hub was admitted on is not an outage.
      fail(
        candidate.id,
        probe.reason,
        probe.state === 'mismatch' &&
          prior.get(candidate.id)?.upstreamOrigin === plan.upstreamOrigin
      );
  }
  const verified = probed
    .filter((entry) => entry.failure === undefined && entry.probe.state === 'verified')
    .sort((a, b) => Number(!prior.has(a.candidate.id)) - Number(!prior.has(b.candidate.id)));
  // Every healthy member's last-known-good binding is reserved before any claim changes, so a
  // member changing its claims can never take a provider another member already holds.
  const reserved = new Map<string, DeploymentSource>();
  for (const { candidate } of verified) {
    const kept = prior.get(candidate.id);
    if (kept && conflict(base, sources, kept) === null) {
      sources.push(kept);
      reserved.set(candidate.id, kept);
    }
  }
  for (const { candidate, plan, probe } of verified) {
    if (plan === undefined || probe?.state !== 'verified') continue;
    const owned = [
      ...new Set(
        (probe.acceptedProviders ?? [candidate.provider]).map(canonicalCredentialProvider)
      ),
    ];
    const source = { ...plan, ...(owned.length ? { providers: owned } : {}) };
    const kept = reserved.get(candidate.id);
    const taken = conflict(
      base,
      sources.filter((entry) => entry !== kept),
      source
    );
    if (taken && kept) outcomes.push({ id: candidate.id, state: 'retained', reason: taken });
    else if (taken) fail(candidate.id, taken);
    else {
      if (kept) sources.splice(sources.indexOf(kept), 1, source);
      else sources.push(source);
      outcomes.push({ id: candidate.id, state: 'admitted' });
    }
  }

  // Sorted so reordering instances.json does not change the revision.
  const admitted = sources
    .slice(base.sources.length)
    .sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1));
  const described = describeSourceManifest({ ...base, sources: [...base.sources, ...admitted] });
  return {
    ...described,
    routes: generateSourceRoutes(described.manifest, described.revision, options.discoveryFile),
    outcomes,
  };
}
