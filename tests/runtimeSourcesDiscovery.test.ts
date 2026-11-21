import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSourceManifest } from '../src/domain/providerSources/manifest';
import type { SourceDiscovery, SourceManifest } from '../src/domain/providerSources/types';
import { SourceRegistry } from '../src/services/providerSources/registry';
import { loadSourceManifest } from '../server/providerSources/config';
import {
  parseInstancesFile,
  resolveEffectiveManifest,
  type ResolveOptions,
} from '../server/providerSources/runtime';
import { createManifestWatcher } from '../server/providerSources/watch';
import { applyRuntimeSources } from '../scripts/prox-sources-apply';

const SHARED_KEY_FILE = '/run/secrets/proxy-management-key';
const HOST_SHARED_KEY = '/host/proxd/management-key';

function baseInput() {
  const source = (instanceId: string, path: string, provider: string, port: number) => ({
    instanceId,
    label: instanceId,
    publicBasePath: path,
    aliases: [] as string[],
    authScope: 'homelab-management',
    providers: [provider],
    upstreamOrigin: `http://127.0.0.1:${port}`,
    managementKeyFile: SHARED_KEY_FILE,
  });
  return {
    schemaVersion: 1 as const,
    defaultInstanceId: 'codex-primary',
    history: { upstreamOrigin: 'http://127.0.0.1:18319', managementKeyFile: SHARED_KEY_FILE },
    sources: [
      source('codex-primary', '/codex', 'codex', 8317),
      source('claude-primary', '/claude', 'claude', 8319),
    ],
  };
}
const base = (): SourceManifest => validateSourceManifest(baseInput());

type Hub = (path: string) => Response;
/** A network where only the listed origins exist; every request is recorded. */
function network(hubs: Record<string, Hub>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, init });
    const hub = hubs[url.origin];
    if (!hub) throw new TypeError('connection refused');
    return hub(url.pathname + url.search);
  }) as typeof fetch;
  return { fetcher, calls };
}
const catalog =
  (instanceId: string | null, accepted?: string[]): Hub =>
  () =>
    Response.json({
      schema_version: 1,
      instance_id: instanceId,
      ...(accepted ? { accepted_providers: accepted } : {}),
      providers: [],
    });
/** A hub that predates the provider catalog. */
const legacyHub =
  (files: unknown[]): Hub =>
  (path) =>
    path.startsWith('/v8/management/credentials')
      ? Response.json({ files })
      : new Response('', { status: 404 });

function options(fetcher: typeof fetch, extra: Partial<ResolveOptions> = {}): ResolveOptions {
  const known: Record<string, string> = { [HOST_SHARED_KEY]: 'shared-key\n' };
  return {
    historyKeyFile: HOST_SHARED_KEY,
    fetcher,
    readKey: async (path) => {
      if (!(path in known)) throw new Error('ENOENT');
      return known[path];
    },
    ...extra,
  };
}
const instances = (...entries: Record<string, unknown>[]) =>
  parseInstancesFile({ instances: entries });
const kimi = { id: 'kimi-primary', provider: 'kimi', base_url: 'http://127.0.0.1:8323' };
/** A run-time hub's public route: its id and a digest of the address it was admitted at. */
const route = (id: string, origin: string) =>
  `/${id}-${createHash('sha256').update(origin).digest('hex').slice(0, 8)}`;
const KIMI = 'http://127.0.0.1:8323';
const ids = (manifest: SourceManifest) => manifest.sources.map((source) => source.instanceId);
const outcome = (result: { outcomes: readonly { id: string }[] }, id: string) =>
  result.outcomes.find((entry) => entry.id === id);

describe('instances.json parsing', () => {
  test('reads the ProxD document and a bare array', () => {
    const entry = { ...kimi, management_path: '/v8/management', label: 'Kimi' };
    const expected = {
      candidates: [
        {
          id: 'kimi-primary',
          provider: 'kimi',
          upstreamOrigin: KIMI,
          label: 'Kimi',
          authScope: undefined,
          ownKey: false,
        },
      ],
      rejected: [],
    };
    expect(parseInstancesFile({ instances: [entry] })).toEqual(expected);
    expect(parseInstancesFile([entry])).toEqual(expected);
  });

  test.each([[null], ['text'], [{}], [{ instances: {} }], [{ instances: 'x' }]])(
    'throws for a document that is not a list: %j',
    (raw) => {
      expect(() => parseInstancesFile(raw)).toThrow('Invalid instances file');
    }
  );

  test('sets a bad entry aside without losing the others', () => {
    const parsed = instances(
      kimi,
      { id: 'no-origin', provider: 'x' },
      { id: 'old-api', provider: 'x', base_url: 'http://127.0.0.1:1', management_path: '/v0' },
      { id: 'typed', provider: 'x', base_url: 'http://127.0.0.1:2', auth_scope: 7 },
      { provider: 'nameless', base_url: 'http://127.0.0.1:3' },
      'not an object'
    );
    expect(parsed.candidates.map((candidate) => candidate.id)).toEqual(['kimi-primary']);
    expect(parsed.rejected.map((entry) => entry.id)).toEqual([
      'no-origin',
      'old-api',
      'typed',
      null,
      null,
    ]);
  });

  test('rejects every entry of an id that is listed twice', () => {
    const parsed = instances(kimi, { ...kimi, base_url: 'http://127.0.0.1:9999' });
    expect(parsed.candidates).toEqual([]);
    expect(parsed.rejected).toEqual([
      { id: 'kimi-primary', reason: 'Instance id is listed more than once' },
    ]);
  });
});

describe('effective manifest admission', () => {
  test('a loopback hub is admitted on the shared key once it proves its instance_id', async () => {
    const { fetcher, calls } = network({ [KIMI]: catalog('kimi-primary', ['kimi', 'moonshot']) });
    const result = await resolveEffectiveManifest(base(), instances(kimi), options(fetcher));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${KIMI}/v8/management/providers`);
    expect(calls[0].init.redirect).toBe('error');
    expect(calls[0].init.headers).toEqual({ Authorization: 'Bearer shared-key' });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);

    expect(outcome(result, 'kimi-primary')).toEqual({ id: 'kimi-primary', state: 'admitted' });
    expect(result.manifest.sources.at(-1)).toEqual({
      instanceId: 'kimi-primary',
      label: 'kimi-primary',
      publicBasePath: route('kimi-primary', KIMI),
      aliases: [],
      authScope: 'homelab-management',
      // The hub's own list, not the single provider its entry names.
      providers: ['kimi', 'moonshot'],
      upstreamOrigin: KIMI,
      managementKeyFile: SHARED_KEY_FILE,
    });
  });

  test('the result is a valid manifest with a content revision, discovery and routes', async () => {
    const { fetcher } = network({ [KIMI]: catalog('kimi-primary', ['kimi']) });
    const result = await resolveEffectiveManifest(
      base(),
      instances(kimi),
      options(fetcher, { discoveryFile: '/etc/nginx/runtime/sources.json' })
    );
    expect(ids(result.manifest)).toEqual(['codex-primary', 'claude-primary', 'kimi-primary']);
    expect(validateSourceManifest(result.manifest)).toEqual(result.manifest);
    expect(result.revision).toBe(
      createHash('sha256').update(JSON.stringify(result.manifest)).digest('hex')
    );
    expect(result.discovery.revision).toBe(result.revision);
    expect(result.discovery.sources.at(-1)).toEqual({
      instanceId: 'kimi-primary',
      label: 'kimi-primary',
      publicBasePath: route('kimi-primary', KIMI),
      aliases: [],
      authScope: 'homelab-management',
      providers: ['kimi'],
    });
    expect(JSON.stringify(result.discovery)).not.toContain('8323');
    expect(result.routes).toContain(
      `location ^~ ${route('kimi-primary', KIMI)}/v8/management/ {\n  proxy_pass ${KIMI}/v8/management/;\n}`
    );
    expect(result.routes).toContain(
      'location = /prox/sources.json { alias /etc/nginx/runtime/sources.json; }'
    );
    // Lets prox-sources-apply see which revision the live Nginx serves.
    expect(result.routes).toContain(`return 200 "${result.revision}";`);
  });

  test('the order of instances.json does not change the revision', async () => {
    const lima = { id: 'lima', provider: 'lima', base_url: 'http://127.0.0.1:8400' };
    const hubs = { [KIMI]: catalog('kimi-primary', ['kimi']), [lima.base_url]: catalog('lima') };
    const forward = await resolveEffectiveManifest(
      base(),
      instances(kimi, lima),
      options(network(hubs).fetcher)
    );
    const reversed = await resolveEffectiveManifest(
      base(),
      instances(lima, kimi),
      options(network(hubs).fetcher)
    );
    expect(ids(forward.manifest).slice(2)).toEqual(['kimi-primary', 'lima']);
    expect(reversed.revision).toBe(forward.revision);
  });

  test('a hub may own provider ids that use the catalog slug rule', async () => {
    const { fetcher } = network({ [KIMI]: catalog('kimi-primary', ['orbit_reader', '9lives']) });
    const result = await resolveEffectiveManifest(base(), instances(kimi), options(fetcher));
    expect(outcome(result, 'kimi-primary')?.state).toBe('admitted');
    expect(result.manifest.sources.at(-1)?.providers).toEqual(['orbit_reader', '9lives']);
  });

  test('a hub without accepted_providers owns the provider its entry names', async () => {
    const { fetcher } = network({ [KIMI]: catalog('kimi-primary') });
    const result = await resolveEffectiveManifest(base(), instances(kimi), options(fetcher));
    expect(result.manifest.sources.at(-1)?.providers).toEqual(['kimi']);
  });

  test('a hub older than the catalog is not admitted, even with matching credentials', async () => {
    const { fetcher, calls } = network({
      [KIMI]: legacyHub([{ name: 'a.json', instance_id: 'kimi-primary' }]),
    });
    const result = await resolveEffectiveManifest(base(), instances(kimi), options(fetcher));
    // Only the catalog proves an identity; the credential list is never asked.
    expect(calls.map((call) => call.url)).toEqual([`${KIMI}/v8/management/providers`]);
    expect(outcome(result, 'kimi-primary')?.state).toBe('rejected');
    expect(ids(result.manifest)).toEqual(['codex-primary', 'claude-primary']);
  });

  const refused: [string, Hub][] = [
    ['another instance_id', catalog('claude-primary')],
    ['no instance_id', catalog(null)],
    ['no provider catalog', legacyHub([{ instance_id: 'kimi-primary' }])],
    ['a redirect', () => new Response('', { status: 302, headers: { Location: 'http://x/' } })],
    ['401', () => new Response('', { status: 401 })],
    ['a body that is not a provider catalog', () => Response.json({ instance_id: 'kimi-primary' })],
    ['a body over the size limit', () => new Response('x'.repeat(1024 * 1024 + 1))],
    [
      'a redirect the transport refuses',
      () => {
        throw new TypeError('unexpected redirect');
      },
    ],
  ];
  test.each(refused)('rejects a hub that answers with %s', async (_name, hub) => {
    const { fetcher } = network({ [KIMI]: hub });
    const result = await resolveEffectiveManifest(base(), instances(kimi), options(fetcher));
    expect(outcome(result, 'kimi-primary')?.state).toBe('rejected');
    expect(ids(result.manifest)).toEqual(['codex-primary', 'claude-primary']);
    expect(result.revision).toBe(createHash('sha256').update(JSON.stringify(base())).digest('hex'));
  });

  test('a remote hub, or one naming its own key, is rejected and never contacted', async () => {
    const remote = 'https://hub.example.test';
    const entry = { id: 'far', provider: 'kimi', base_url: remote };
    for (const partial of [
      entry,
      { ...entry, auth_scope: 'far-scope' },
      { ...entry, auth_scope: 'far-scope', management_key_file: '/host/proxd/hub-keys/far' },
      // A loopback hub with its own key is not admitted at run time either.
      { ...entry, base_url: KIMI, auth_scope: 'own', management_key_file: HOST_SHARED_KEY },
      { ...entry, base_url: KIMI, management_key_file: '/etc/passwd' },
      // Lookalike loopback addresses are not on the allowlist.
      { ...entry, base_url: 'http://127.0.0.2:8317' },
      { ...entry, base_url: 'http://localhost.example.test:8317' },
    ]) {
      const { fetcher, calls } = network({ [remote]: catalog('far'), [KIMI]: catalog('far') });
      const read: string[] = [];
      const result = await resolveEffectiveManifest(base(), instances(partial), {
        ...options(fetcher),
        readKey: async (path) => {
          read.push(path);
          return 'key';
        },
      });
      expect(outcome(result, 'far')?.state).toBe('rejected');
      expect(outcome(result, 'far')?.reason).toContain('provider-sources.json');
      expect(calls).toEqual([]);
      expect(read).toEqual([]);
      expect(ids(result.manifest)).toEqual(['codex-primary', 'claude-primary']);
    }
  });

  // "anthropic" is the OAuth name of the credential type the baked Claude source owns.
  test.each([[['kimi', 'claude']], [['kimi', 'anthropic']]])(
    'a hub claiming a provider that already has an owner is rejected, not given it: %j',
    async (accepted) => {
      const { fetcher } = network({ [KIMI]: catalog('kimi-primary', accepted) });
      const result = await resolveEffectiveManifest(base(), instances(kimi), options(fetcher));
      expect(outcome(result, 'kimi-primary')).toEqual({
        id: 'kimi-primary',
        state: 'rejected',
        reason: 'Provider declared by more than one source',
      });
      expect(result.manifest).toEqual(base());
    }
  );

  test('between two new hubs the earlier member keeps a contested provider', async () => {
    const lima = { id: 'lima', provider: 'kimi', base_url: 'http://127.0.0.1:8400' };
    const hubs = { [KIMI]: catalog('kimi-primary'), [lima.base_url]: catalog('lima') };
    const first = await resolveEffectiveManifest(
      base(),
      instances(lima),
      options(network(hubs).fetcher)
    );
    // kimi-primary is listed first, but lima is already a member.
    const second = await resolveEffectiveManifest(
      base(),
      instances(kimi, lima),
      options(network(hubs).fetcher, { previous: first.manifest })
    );
    expect(outcome(second, 'lima')?.state).toBe('admitted');
    expect(outcome(second, 'kimi-primary')?.state).toBe('rejected');
  });

  test('baked sources win on id, without a probe', async () => {
    const moved = { id: 'claude-primary', provider: 'kimi', base_url: KIMI };
    const { fetcher, calls } = network({ [KIMI]: catalog('claude-primary') });
    const result = await resolveEffectiveManifest(base(), instances(moved), options(fetcher));
    expect(outcome(result, 'claude-primary')).toEqual({ id: 'claude-primary', state: 'base' });
    expect(calls).toEqual([]);
    expect(result.manifest).toEqual(base());
  });

  test('an unreadable key is a rejection, and the hub is not contacted', async () => {
    const { fetcher, calls } = network({ [KIMI]: catalog('kimi-primary') });
    const result = await resolveEffectiveManifest(base(), instances(kimi), {
      ...options(fetcher),
      historyKeyFile: '/host/missing',
    });
    expect(outcome(result, 'kimi-primary')?.reason).toBe('Management key file is unreadable');
    expect(calls).toEqual([]);
  });
});

describe('last-known-good membership', () => {
  async function admitted() {
    const { fetcher } = network({ [KIMI]: catalog('kimi-primary', ['kimi']) });
    return (await resolveEffectiveManifest(base(), instances(kimi), options(fetcher))).manifest;
  }

  test('an unreachable hub keeps its membership and its revision', async () => {
    const previous = await admitted();
    for (const hubs of [{}, { [KIMI]: (() => new Response('', { status: 503 })) as Hub }]) {
      const result = await resolveEffectiveManifest(
        base(),
        instances(kimi),
        options(network(hubs).fetcher, { previous })
      );
      expect(outcome(result, 'kimi-primary')?.state).toBe('retained');
      expect(result.manifest).toEqual(previous);
    }
  });

  test('an entry that became unreadable keeps the hub it described', async () => {
    const previous = await admitted();
    for (const broken of [
      { id: 'kimi-primary', provider: 'kimi' },
      { provider: 'kimi', base_url: KIMI },
      { ...kimi, base_url: 'https://hub.example.test' },
    ]) {
      const result = await resolveEffectiveManifest(
        base(),
        instances(broken),
        options(network({}).fetcher, { previous })
      );
      expect(outcome(result, 'kimi-primary')?.state).toBe('retained');
      expect(result.manifest).toEqual(previous);
    }
  });

  test('a hub leaves when its entry is removed', async () => {
    const result = await resolveEffectiveManifest(
      base(),
      instances(),
      options(network({}).fetcher, { previous: await admitted() })
    );
    expect(outcome(result, 'kimi-primary')).toEqual({ id: 'kimi-primary', state: 'removed' });
    expect(result.manifest).toEqual(base());
  });

  test('a hub leaves when another instance answers at its address', async () => {
    const { fetcher } = network({ [KIMI]: catalog('someone-else') });
    const result = await resolveEffectiveManifest(
      base(),
      instances(kimi),
      options(fetcher, { previous: await admitted() })
    );
    expect(outcome(result, 'kimi-primary')?.state).toBe('rejected');
    expect(result.manifest).toEqual(base());
  });

  test('a hub at a new address gets a new route, so old sessions cannot follow it', async () => {
    const previous = await admitted();
    const moved = { ...kimi, base_url: 'http://127.0.0.1:8499' };
    const { fetcher } = network({ [moved.base_url]: catalog('kimi-primary', ['kimi']) });
    const result = await resolveEffectiveManifest(
      base(),
      instances(moved),
      options(fetcher, { previous })
    );
    expect(outcome(result, 'kimi-primary')?.state).toBe('admitted');
    const paths = (manifest: SourceManifest) =>
      manifest.sources.filter((s) => s.instanceId === 'kimi-primary').map((s) => s.publicBasePath);
    expect(paths(previous)).toEqual([route('kimi-primary', KIMI)]);
    expect(paths(result.manifest)).toEqual([route('kimi-primary', moved.base_url)]);
    expect(route('kimi-primary', KIMI)).not.toBe(route('kimi-primary', moved.base_url));
  });

  test('a healthy member cannot take a provider another healthy member holds', async () => {
    const lima = { id: 'lima', provider: 'lima', base_url: 'http://127.0.0.1:8400' };
    const first = await resolveEffectiveManifest(
      base(),
      instances(kimi, lima),
      options(
        network({ [KIMI]: catalog('kimi-primary', ['kimi']), [lima.base_url]: catalog('lima') })
          .fetcher
      )
    );
    // Both answer; lima, listed first, now also claims kimi.
    const result = await resolveEffectiveManifest(
      base(),
      instances(lima, kimi),
      options(
        network({
          [KIMI]: catalog('kimi-primary', ['kimi']),
          [lima.base_url]: catalog('lima', ['lima', 'kimi']),
        }).fetcher,
        { previous: first.manifest }
      )
    );
    expect(outcome(result, 'kimi-primary')?.state).toBe('admitted');
    expect(outcome(result, 'lima')).toEqual({
      id: 'lima',
      state: 'retained',
      reason: 'Provider declared by more than one source',
    });
    const providers = (id: string) =>
      result.manifest.sources.find((source) => source.instanceId === id)?.providers;
    expect(providers('kimi-primary')).toEqual(['kimi']);
    expect(providers('lima')).toEqual(['lima']);
  });

  test('an offline member keeps its provider against a healthy member listed first', async () => {
    const lima = { id: 'lima', provider: 'lima', base_url: 'http://127.0.0.1:8400' };
    const first = await resolveEffectiveManifest(
      base(),
      instances(kimi, lima),
      options(
        network({ [KIMI]: catalog('kimi-primary', ['kimi']), [lima.base_url]: catalog('lima') })
          .fetcher
      )
    );
    // kimi-primary is offline; lima now claims kimi too and is listed first.
    const result = await resolveEffectiveManifest(
      base(),
      instances(lima, kimi),
      options(network({ [lima.base_url]: catalog('lima', ['lima', 'kimi']) }).fetcher, {
        previous: first.manifest,
      })
    );
    expect(outcome(result, 'kimi-primary')?.state).toBe('retained');
    // lima's new claim conflicts, so it keeps its own last-known-good binding.
    expect(outcome(result, 'lima')?.state).toBe('retained');
    const providers = (id: string) =>
      result.manifest.sources.find((source) => source.instanceId === id)?.providers;
    expect(providers('kimi-primary')).toEqual(['kimi']);
    expect(providers('lima')).toEqual(['lima']);
  });

  test('a hub dropped from the baked manifest is not kept through instances.json', async () => {
    // The previous effective manifest had a remote, own-key hub that was baked then.
    const input = baseInput();
    input.sources.push({
      ...input.sources[0],
      instanceId: 'far',
      label: 'far',
      publicBasePath: '/far',
      authScope: 'far-scope',
      providers: ['far'],
      upstreamOrigin: 'https://hub.example.test',
      managementKeyFile: '/run/secrets/far-key',
    });
    const previous = validateSourceManifest(input);
    const result = await resolveEffectiveManifest(
      base(),
      instances({ id: 'far', provider: 'far', base_url: 'https://hub.example.test' }),
      options(network({}).fetcher, { previous })
    );
    expect(outcome(result, 'far')?.state).toBe('rejected');
    expect(ids(result.manifest)).toEqual(['codex-primary', 'claude-primary']);
  });

  test('a retained hub still yields to a baked source that now claims its provider', async () => {
    const previous = await admitted();
    const input = baseInput();
    input.sources[1].providers = ['claude', 'kimi'];
    const result = await resolveEffectiveManifest(
      validateSourceManifest(input),
      instances(kimi),
      options(network({}).fetcher, { previous })
    );
    expect(outcome(result, 'kimi-primary')?.state).toBe('rejected');
    expect(ids(result.manifest)).toEqual(['codex-primary', 'claude-primary']);
  });
});

describe('prox-sources-apply', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function setup(hubs: Record<string, Hub>) {
    const root = mkdtempSync(join(tmpdir(), 'prox-sources-apply-'));
    directories.push(root);
    const runtimeDir = join(root, 'sources');
    const instancesPath = join(root, 'instances.json');
    writeFileSync(join(root, 'base.json'), JSON.stringify(baseInput()));
    writeFileSync(join(root, 'management-key'), 'shared-key\n');
    writeFileSync(instancesPath, JSON.stringify({ instances: [kimi] }));
    const steps: string[] = [];
    const state = {
      hubs,
      validate: async (_staging: string) => {},
      reload: async () => {},
      verify: async (_revision: string, _added: readonly { instanceId: string }[]) => {},
      seed: false,
    };
    const run = () =>
      applyRuntimeSources({
        baseManifestPath: join(root, 'base.json'),
        instancesPath,
        runtimeDir,
        historyKeyFile: join(root, 'management-key'),
        fetcher: network(state.hubs).fetcher,
        validate: async (staging) => {
          steps.push(`validate:${existsSync(join(runtimeDir, 'sources.json'))}`);
          await state.validate(staging);
        },
        reload: async () => {
          steps.push(`reload:${existsSync(join(runtimeDir, 'sources.json'))}`);
          await state.reload();
        },
        verify: async (revision, added) => {
          steps.push(`verify:${added.map((source) => source.instanceId).join(',')}`);
          await state.verify(revision, added);
        },
        seed: state.seed,
      });
    // A leftover staging directory shows up as an entry, so "intact" also means cleaned up.
    const snapshot = (): Record<string, string> =>
      Object.fromEntries(
        (existsSync(runtimeDir) ? readdirSync(runtimeDir) : []).map((name) => {
          const path = join(runtimeDir, name);
          return [name, statSync(path).isDirectory() ? '<directory>' : readFileSync(path, 'utf8')];
        })
      );
    return { runtimeDir, instancesPath, steps, state, run, snapshot };
  }
  const lima = { id: 'lima', provider: 'lima', base_url: 'http://127.0.0.1:8400' };
  const both: Record<string, Hub> = {
    [KIMI]: catalog('kimi-primary', ['kimi']),
    [lima.base_url]: catalog('lima'),
  };

  test('publishes the three files with their modes, discovery only after a reload', async () => {
    const { runtimeDir, steps, run, snapshot } = setup(both);
    const result = await run();
    expect(result.changed).toBe(true);
    expect(steps).toEqual(['validate:false', 'reload:false', 'verify:kimi-primary']);
    expect(Object.keys(snapshot()).sort()).toEqual([
      'effective-manifest.json',
      'provider-routes.conf',
      'sources.json',
    ]);
    const mode = (name: string) => statSync(join(runtimeDir, name)).mode & 0o777;
    expect(mode('effective-manifest.json')).toBe(0o600);
    expect(mode('provider-routes.conf')).toBe(0o644);
    expect(mode('sources.json')).toBe(0o644);

    const loaded = loadSourceManifest(join(runtimeDir, 'effective-manifest.json'));
    expect(loaded.revision).toBe(result.revision);
    expect(ids(loaded.manifest)).toEqual(['codex-primary', 'claude-primary', 'kimi-primary']);
    expect(JSON.parse(snapshot()['sources.json'])).toEqual(loaded.discovery);
    expect(snapshot()['provider-routes.conf']).toContain(`revision ${result.revision}`);
    expect(snapshot()['provider-routes.conf']).toContain(
      'location = /prox/sources.json { alias /etc/nginx/runtime/sources.json; }'
    );
  });

  test('validation sees the staged files before anything is live', async () => {
    const { runtimeDir, state, run } = setup(both);
    let staged: string[] = [];
    state.validate = async (staging) => {
      expect(staging.startsWith(runtimeDir)).toBe(true);
      staged = readdirSync(staging).sort();
      expect(readFileSync(join(staging, 'provider-routes.conf'), 'utf8')).toContain(
        `${route('kimi-primary', KIMI)}/`
      );
    };
    await run();
    expect(staged).toEqual(['effective-manifest.json', 'provider-routes.conf', 'sources.json']);
  });

  test('an unchanged result is not rewritten and Nginx is not reloaded', async () => {
    const { steps, run, snapshot } = setup(both);
    await run();
    const before = snapshot();
    steps.length = 0;
    expect((await run()).changed).toBe(false);
    expect(steps).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  test('a failed nginx -t leaves the previous directory intact', async () => {
    const { instancesPath, state, steps, run, snapshot } = setup(both);
    await run();
    const before = snapshot();
    writeFileSync(instancesPath, JSON.stringify({ instances: [kimi, lima] }));
    state.validate = async () => {
      throw new Error('nginx: configuration file test failed');
    };
    steps.length = 0;
    await expect(run()).rejects.toThrow('test failed');
    expect(steps).toEqual(['validate:true']);
    expect(snapshot()).toEqual(before);
  });

  test('a failed nginx -t on the first run publishes nothing', async () => {
    const { state, run, snapshot } = setup(both);
    state.validate = async () => {
      throw new Error('nginx: configuration file test failed');
    };
    await expect(run()).rejects.toThrow();
    expect(snapshot()).toEqual({});
  });

  test('a failed reload puts the previous routes back and publishes no discovery', async () => {
    const { instancesPath, state, run, snapshot } = setup(both);
    await run();
    const before = snapshot();
    writeFileSync(instancesPath, JSON.stringify({ instances: [kimi, lima] }));
    let routesDuringReload = '';
    state.reload = async () => {
      routesDuringReload = snapshot()['provider-routes.conf'];
      throw new Error('reload failed');
    };
    await expect(run()).rejects.toThrow('reload failed');
    expect(routesDuringReload).toContain(`${route('lima', lima.base_url)}/`);
    expect(snapshot()).toEqual(before);

    // The next run is not confused by the failed one.
    state.reload = async () => {};
    expect((await run()).changed).toBe(true);
    expect(snapshot()['sources.json']).toContain('"lima"');
  });

  test('routes Nginx does not serve yet are rolled back and nothing is published', async () => {
    const { instancesPath, state, steps, run, snapshot } = setup(both);
    await run();
    const before = snapshot();
    writeFileSync(instancesPath, JSON.stringify({ instances: [kimi, lima] }));
    state.verify = async () => {
      throw new Error('Nginx does not route lima');
    };
    steps.length = 0;
    await expect(run()).rejects.toThrow('does not route');
    // Reloaded onto the new routes, then back onto the previous ones.
    // Only the binding new in this run is asked; kimi-primary was verified when it was admitted.
    expect(steps).toEqual(['validate:true', 'reload:true', 'verify:lima', 'reload:true']);
    expect(snapshot()).toEqual(before);
  });

  test('an offline hub kept from before does not hold back a new admission', async () => {
    const { instancesPath, state, steps, run, snapshot } = setup(both);
    await run();
    state.hubs = { [lima.base_url]: both[lima.base_url] };
    writeFileSync(instancesPath, JSON.stringify({ instances: [kimi, lima] }));
    steps.length = 0;
    const result = await run();
    expect(outcome(result, 'kimi-primary')?.state).toBe('retained');
    expect(steps).toEqual(['validate:true', 'reload:true', 'verify:lima']);
    expect(snapshot()['sources.json']).toContain('"lima"');
  });

  test('--seed publishes the baked sources without Nginx, once', async () => {
    const { state, steps, run, snapshot } = setup(both);
    state.seed = true;
    const seeded = await run();
    expect(steps).toEqual(['validate:false']);
    expect(seeded.outcomes).toEqual([]);
    expect(Object.keys(snapshot()).sort()).toEqual([
      'effective-manifest.json',
      'provider-routes.conf',
      'sources.json',
    ]);
    expect(snapshot()['sources.json']).not.toContain('kimi-primary');
    await expect(run()).rejects.toThrow('Already seeded');
    state.seed = false;
    steps.length = 0;
    await run();
    expect(steps).toEqual(['validate:true', 'reload:true', 'verify:kimi-primary']);
  });

  test('a first run whose routes are not served leaves nothing behind', async () => {
    const { state, run, snapshot } = setup(both);
    state.verify = async () => {
      throw new Error('Nginx does not route kimi-primary');
    };
    await expect(run()).rejects.toThrow();
    expect(snapshot()).toEqual({});
  });

  test.each(['{ "instances": [', '"instances"', '{"instances": {}}'])(
    'a malformed instances.json leaves the previous directory intact: %s',
    async (text) => {
      const { instancesPath, steps, run, snapshot } = setup(both);
      await run();
      const before = snapshot();
      writeFileSync(instancesPath, text);
      steps.length = 0;
      await expect(run()).rejects.toThrow();
      expect(steps).toEqual([]);
      expect(snapshot()).toEqual(before);
    }
  );

  test('a hub outage between runs keeps the hub published', async () => {
    const { instancesPath, state, run, snapshot } = setup(both);
    await run();
    state.hubs = { [lima.base_url]: both[lima.base_url] };
    writeFileSync(instancesPath, JSON.stringify({ instances: [kimi, lima] }));
    const result = await run();
    expect(outcome(result, 'kimi-primary')?.state).toBe('retained');
    expect(outcome(result, 'lima')?.state).toBe('admitted');
    const published = JSON.parse(snapshot()['sources.json']) as SourceDiscovery;
    expect(published.sources.map((source) => source.instanceId)).toEqual([
      'codex-primary',
      'claude-primary',
      'kimi-primary',
      'lima',
    ]);
  });

  test('a published manifest that no longer validates stops the run', async () => {
    const { runtimeDir, run, snapshot } = setup(both);
    await run();
    writeFileSync(join(runtimeDir, 'effective-manifest.json'), '{}');
    const before = snapshot();
    await expect(run()).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });
});

describe('prox-history manifest watcher', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  function setup() {
    const directory = mkdtempSync(join(tmpdir(), 'prox-manifest-watch-'));
    directories.push(directory);
    const path = join(directory, 'effective-manifest.json');
    let clock = 1_800_000_000;
    const write = (text: string) => {
      writeFileSync(path, text);
      clock += 10;
      utimesSync(path, clock, clock);
    };
    write(JSON.stringify(baseInput()));
    const added: { ids: string[]; revision: string }[] = [];
    const warnings: string[] = [];
    const check = createManifestWatcher(
      path,
      loadSourceManifest(path),
      (manifest, revision) => added.push({ ids: ids(manifest), revision }),
      (message) => warnings.push(message)
    );
    return { path, write, added, warnings, check };
  }
  const withHub = (id: string, port: number) => {
    const input = baseInput();
    input.sources.push({
      ...input.sources[0],
      instanceId: id,
      label: id,
      publicBasePath: `/${id}`,
      providers: [id],
      upstreamOrigin: `http://127.0.0.1:${port}`,
    });
    return input;
  };

  test('reports a revision that adds a source, once', () => {
    const { path, write, added, warnings, check } = setup();
    check();
    expect(added).toEqual([]);
    write(JSON.stringify(withHub('kimi', 8323)));
    check();
    check();
    expect(added).toEqual([
      {
        ids: ['codex-primary', 'claude-primary', 'kimi'],
        revision: loadSourceManifest(path).revision,
      },
    ]);
    expect(warnings).toEqual([]);
  });

  test('ignores a malformed or invalid edit, warns once, and recovers', () => {
    const { write, added, warnings, check } = setup();
    write('{ "schemaVersion": 1,');
    check();
    check();
    write(JSON.stringify({ ...baseInput(), defaultInstanceId: 'missing' }));
    check();
    expect(added).toEqual([]);
    expect(warnings).toHaveLength(2);
    write(JSON.stringify(withHub('kimi', 8323)));
    check();
    expect(added).toHaveLength(1);
  });

  test('delivers each revision once, removals included, and a missing file is not fatal', () => {
    const { path, write, added, warnings, check } = setup();
    const fewer = baseInput();
    fewer.sources.pop();
    write(JSON.stringify(fewer));
    check();
    check();
    // The collector decides what a revision means; it only ever adds (quotaCollector test).
    expect(added.map((entry) => entry.ids)).toEqual([['codex-primary']]);
    expect(warnings).toEqual([]);
    rmSync(path);
    expect(() => check()).not.toThrow();
    expect(added).toHaveLength(1);
  });

  test('a revision the consumer failed on is delivered again on the next check', () => {
    const { path, write } = setup();
    let fail = true;
    const delivered: string[] = [];
    const warnings: string[] = [];
    const watcher = createManifestWatcher(
      path,
      loadSourceManifest(path),
      (_manifest, revision) => {
        if (fail) throw new Error('collector refused');
        delivered.push(revision);
      },
      (message) => warnings.push(message)
    );
    write(JSON.stringify(withHub('kimi', 8323)));
    expect(() => watcher()).not.toThrow();
    expect(delivered).toEqual([]);
    expect(warnings).toHaveLength(1);
    fail = false;
    watcher();
    watcher();
    expect(delivered).toEqual([loadSourceManifest(path).revision]);
  });
});

describe('browser discovery revision refresh', () => {
  const origin = 'https://fixture.invalid';
  const source = (instanceId: string, authScope = 'shared') => ({
    instanceId,
    label: instanceId,
    publicBasePath: `/${instanceId}`,
    aliases: [] as string[],
    authScope,
  });
  const discovery = (revision: string, ...names: string[]): SourceDiscovery => ({
    schemaVersion: 1,
    revision: revision.repeat(64),
    defaultInstanceId: names[0],
    sources: names.map((name) => source(name)),
  });
  async function connected(first: SourceDiscovery) {
    const state: { next: SourceDiscovery | null | Error } = { next: first };
    const registry = new SourceRegistry(async () => {
      if (state.next instanceof Error) throw state.next;
      return state.next;
    });
    await registry.connect(`${origin}/first`, 'fixture-key', origin);
    return { registry, state };
  }

  test('a new revision adds a hub and keeps the sessions of the others', async () => {
    const { registry, state } = await connected(discovery('a', 'first', 'second'));
    const before = registry.getSnapshot();
    const sessions = before.sources.map((view) => view.session!);
    let published = 0;
    registry.subscribe(() => published++);

    state.next = discovery('b', 'first', 'second', 'third');
    expect(await registry.refreshDiscovery()).toBe(true);

    const after = registry.getSnapshot();
    expect(published).toBe(1);
    expect(after.status).toBe('ready');
    expect(after.resolution?.revision).toBe('b'.repeat(64));
    expect(after.sources.map((view) => view.source.instanceId)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(after.sources[0].session).toBe(sessions[0]);
    expect(after.sources[1].session).toBe(sessions[1]);
    for (const session of sessions) {
      expect(session.signal.aborted).toBe(false);
      expect(() => session.assertCurrent()).not.toThrow();
    }
    expect(after.sources[2].status).toBe('ready');
    expect(after.sources[2].session?.owner.instanceId).toBe('third');
    expect(JSON.stringify(after)).not.toContain('fixture-key');
  });

  test('what a hub already reported survives the refresh', async () => {
    const { registry, state } = await connected(discovery('a', 'first', 'second'));
    await expect(
      registry.getSnapshot().sources[1].session!.management.get('/credentials', {
        adapter: async (config) => {
          throw { isAxiosError: true, message: 'Unauthorized', config, response: { status: 401 } };
        },
      })
    ).rejects.toThrow();
    state.next = discovery('b', 'first', 'second', 'third');
    await registry.refreshDiscovery();
    expect(registry.getSnapshot().sources.map((view) => view.status)).toEqual([
      'ready',
      'unauthorized',
      'ready',
    ]);
  });

  test('an unchanged, missing or failing discovery leaves the snapshot untouched', async () => {
    const { registry, state } = await connected(discovery('a', 'first', 'second'));
    const before = registry.getSnapshot();
    for (const next of [
      before.resolution && discovery('a', 'first', 'second'),
      null,
      new Error('x'),
    ]) {
      state.next = next;
      expect(await registry.refreshDiscovery()).toBe(false);
      expect(registry.getSnapshot()).toBe(before);
    }
    expect(() => before.sources[0].session!.assertCurrent()).not.toThrow();
  });

  test('a removed hub loses its session; the hub signed in to is never dropped', async () => {
    const { registry, state } = await connected(discovery('a', 'first', 'second'));
    const [first, second] = registry.getSnapshot().sources.map((view) => view.session!);
    state.next = discovery('b', 'first');
    expect(await registry.refreshDiscovery()).toBe(true);
    expect(registry.getSnapshot().sources).toHaveLength(1);
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);

    const settled = registry.getSnapshot();
    state.next = discovery('c', 'second');
    expect(await registry.refreshDiscovery()).toBe(false);
    expect(registry.getSnapshot()).toBe(settled);
    expect(first.signal.aborted).toBe(false);
  });

  test('a hub whose scope changed is re-authenticated, not silently kept', async () => {
    const { registry, state } = await connected(discovery('a', 'first', 'second'));
    const second = registry.getSnapshot().sources[1].session!;
    state.next = {
      ...discovery('b', 'first', 'second'),
      sources: [source('first'), source('second', 'separate')],
    };
    await registry.refreshDiscovery();
    const view = registry.getSnapshot().sources[1];
    expect(view.status).toBe('authentication-required');
    expect(view.session).toBeNull();
    expect(second.signal.aborted).toBe(true);
  });

  test('a refresh that moves the signed-in hub to another scope is not adopted', async () => {
    const { registry, state } = await connected(discovery('a', 'first', 'second'));
    const before = registry.getSnapshot();
    // "second" was isolated in its own scope; "first", signed in with this key, moves there.
    state.next = {
      ...discovery('b', 'first', 'second'),
      sources: [source('first', 'separate'), source('second', 'separate')],
    };
    expect(await registry.refreshDiscovery()).toBe(false);
    expect(registry.getSnapshot()).toBe(before);
  });

  test('does nothing when disconnected, external, or after logout', async () => {
    const calls: string[] = [];
    const registry = new SourceRegistry(async (appOrigin) => {
      calls.push(appOrigin);
      return discovery('a', 'first');
    });
    expect(await registry.refreshDiscovery()).toBe(false);
    await registry.connect('https://other.invalid/prefix', 'fixture', origin);
    expect(await registry.refreshDiscovery()).toBe(false);
    expect(calls).toEqual([]);

    await registry.connect(`${origin}/first`, 'fixture', origin);
    registry.reset();
    expect(await registry.refreshDiscovery()).toBe(false);
    expect(calls).toHaveLength(1);
    expect(registry.getSnapshot().status).toBe('disconnected');
  });

  test('a discovery that arrives after logout cannot resurrect the session', async () => {
    let release!: (value: SourceDiscovery) => void;
    let reads = 0;
    const registry = new SourceRegistry(() =>
      ++reads === 1
        ? Promise.resolve(discovery('a', 'first'))
        : new Promise((resolve) => {
            release = resolve;
          })
    );
    await registry.connect(`${origin}/first`, 'fixture', origin);
    const pending = registry.refreshDiscovery();
    registry.reset();
    release(discovery('b', 'first', 'second'));
    expect(await pending).toBe(false);
    expect(registry.getSnapshot().status).toBe('disconnected');
  });
});

describe('deployment templates', () => {
  const read = (name: string) =>
    readFileSync(new URL(`../deploy/${name}`, import.meta.url), 'utf8');

  test('Nginx keeps the baked routes and only globs the optional runtime ones', () => {
    const conf = read('nginx.conf');
    expect(conf).toContain('include /etc/nginx/provider-routes.conf;');
    expect(conf).toContain('include /etc/nginx/runtime/provider-routes*.conf;');
  });

  test('the containers mount nothing for runtime discovery by default', () => {
    for (const unit of ['prox.container', 'prox-history.container']) {
      const lines = read(unit)
        .split('\n')
        .filter((line) => !line.startsWith('#'));
      expect(lines.join('\n')).not.toContain('prox/sources');
      expect(lines.join('\n')).not.toContain('PROX_SOURCE_MANIFEST');
    }
  });

  test('the path unit watches instances.json and starts the oneshot', () => {
    const path = read('prox-sources.path');
    expect(path).toContain('PathChanged=%h/.config/cli-proxy/instances.json');
    expect(path).toContain('Unit=prox-sources-apply.service');
    const service = read('prox-sources-apply.service');
    expect(service).toContain('Type=oneshot');
    expect(service).toContain('%h/.local/share/prox/sources-apply/prox-sources-apply.js');
    // Enablement is the operator's: the service has no install target of its own.
    expect(service).not.toContain('[Install]');
    const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      .scripts as Record<string, string>;
    expect(scripts['build:sources-apply']).toContain('./scripts/prox-sources-apply.ts');
    expect(scripts.build).toContain('bun run build:sources-apply');
  });
});
