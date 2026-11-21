import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import en from '@/i18n/locales/en.json';
import i18n from '@/i18n';
import { parseProviderCatalog, type ProviderCatalog } from '@/domain/providerCatalog';
import { createProviderCatalogApi, type ProviderCatalogRead } from '@/services/api/providerCatalog';
import { createOAuthApi } from '@/services/api/oauth';
import { apiClient } from '@/services/api/client';
import { pluginsApi } from '@/services/api/plugins';
import type { ManagementTransport, SourceOwner } from '@/services/api/sourceSession';
import {
  createProviderCatalogStore,
  selectSourceCatalog,
  usableCatalog,
  useProviderCatalogStore,
  type CatalogSession,
} from '@/stores/useProviderCatalogStore';
import {
  OAUTH_PROVIDERS,
  buildCatalogOAuthProviderCards,
  supportsManualCallback,
  type OAuthProviderCard,
} from '@/features/oauth/providers';
import { OAuthPage } from '@/features/oauth/OAuthPage';
import { SelectedSourceBoundary } from '@/components/sources/SelectedSourceBoundary';
import { providerSources } from '@/stores/useProviderSources';
import {
  awaitingAuthProviders,
  awaitingMatchesFilters,
} from '@/features/authFiles/awaitingProviders';
import { AwaitingAuthCard } from '@/features/authFiles/components/AwaitingAuthCard';
import { createPluginQuotaConfig } from '@/features/quota/providers/plugin/data';
import { testQuotaDependencies } from './helpers/quotaDependencies';

const GOLDEN_PATH = join(import.meta.dir, 'fixtures/providerCatalog/catalog.golden.json');
const goldenRaw = () => JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, unknown>;
const golden = (): ProviderCatalog => parseProviderCatalog(goldenRaw())!;

const owner = (instanceId = 'gemini-primary', sourceGeneration = 1): SourceOwner =>
  Object.freeze({ instanceId, sessionEpoch: 0, sourceGeneration });

const session = (o: SourceOwner = owner(), controller = new AbortController()): CatalogSession => ({
  owner: o,
  signal: controller.signal,
  management: {} as ManagementTransport,
});

const httpError = (status: number, apiCode?: string) =>
  Object.assign(new Error(`HTTP ${status}`), { status, apiCode });

/** A promise the test settles by hand, to order responses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('provider catalog API', () => {
  test('reads GET /providers, validates it and keeps the ETag', async () => {
    const calls: unknown[][] = [];
    const api = createProviderCatalogApi({
      getRaw: (async (...args: unknown[]) => {
        calls.push(args);
        return { status: 200, data: goldenRaw(), headers: { etag: '"v1"' } };
      }) as unknown as ManagementTransport['getRaw'],
    });
    const result = await api.read(null);
    expect(result.status).toBe('changed');
    const changed = result as Extract<ProviderCatalogRead, { status: 'changed' }>;
    expect(changed.etag).toBe('"v1"');
    expect(changed.catalog.providers.map((entry) => entry.id)).toEqual([
      'antigravity',
      'example-plugin',
    ]);
    const [url, config] = calls[0] as [
      string,
      { headers: object; validateStatus: (s: number) => boolean },
    ];
    expect(url).toBe('/providers');
    expect(config.headers).toEqual({});
    expect(config.validateStatus(304)).toBe(true);
    expect(config.validateStatus(404)).toBe(false);
  });

  test('sends If-None-Match and reports 304 as unchanged', async () => {
    let headers: unknown;
    const api = createProviderCatalogApi({
      getRaw: (async (_url: string, config: { headers: unknown }) => {
        headers = config.headers;
        return { status: 304, data: '', headers: {} };
      }) as unknown as ManagementTransport['getRaw'],
    });
    expect(await api.read('"v1"')).toEqual({ status: 'unchanged' });
    expect(headers).toEqual({ 'If-None-Match': '"v1"' });
  });

  test('rejects a malformed catalog instead of showing it', async () => {
    const api = createProviderCatalogApi({
      getRaw: (async () => ({
        status: 200,
        data: { ...goldenRaw(), schema_version: 99 },
        headers: {},
      })) as unknown as ManagementTransport['getRaw'],
    });
    await expect(api.read(null)).rejects.toThrow('Invalid provider catalog');
  });
});

describe('per-source provider catalog store', () => {
  const fakeStore = (read: (etag: string | null) => Promise<ProviderCatalogRead>) => {
    const etags: Array<string | null> = [];
    const store = createProviderCatalogStore(() => ({
      read: (etag) => {
        etags.push(etag);
        return read(etag);
      },
    }));
    return { store, etags };
  };

  test('loads once per session, then re-reads conditionally on force', async () => {
    const { store, etags } = fakeStore(async (etag) =>
      etag ? { status: 'unchanged' } : { status: 'changed', catalog: golden(), etag: '"v1"' }
    );
    const s = session();
    await Promise.all([store.getState().ensure(s), store.getState().ensure(s)]);
    await store.getState().ensure(s);
    expect(etags).toEqual([null]);
    const slice = selectSourceCatalog(store.getState(), s.owner);
    expect(slice?.status).toBe('ready');
    expect(usableCatalog(slice)?.instanceId).toBe('gemini-primary');

    await store.getState().ensure(s, { force: true });
    expect(etags).toEqual([null, '"v1"']);
    expect(usableCatalog(selectSourceCatalog(store.getState(), s.owner))).toEqual(golden());
  });

  test('records an older ProxD (404) as unsupported and does not ask again', async () => {
    const { store, etags } = fakeStore(async () => {
      throw httpError(404);
    });
    const s = session();
    await store.getState().ensure(s);
    await store.getState().ensure(s);
    const slice = selectSourceCatalog(store.getState(), s.owner);
    expect(slice).toMatchObject({ status: 'unsupported', catalog: null, error: null });
    expect(usableCatalog(slice)).toBeNull();
    expect(etags).toHaveLength(1);
  });

  test('keeps the last good catalog through a failed re-read; a first failure is an error', async () => {
    let fail = false;
    const { store } = fakeStore(async () => {
      if (fail) throw httpError(502);
      return { status: 'changed', catalog: golden(), etag: null };
    });
    const s = session();
    await store.getState().ensure(s);
    fail = true;
    await store.getState().ensure(s, { force: true });
    expect(selectSourceCatalog(store.getState(), s.owner)).toMatchObject({
      status: 'ready',
      catalog: golden(),
      error: 'HTTP 502',
    });

    const other = session(owner('claude-primary'));
    await store.getState().ensure(other);
    expect(selectSourceCatalog(store.getState(), other.owner)).toMatchObject({
      status: 'error',
      catalog: null,
    });
    // An error is retried by the next plain ensure.
    fail = false;
    await store.getState().ensure(other);
    expect(selectSourceCatalog(store.getState(), other.owner)?.status).toBe('ready');
  });

  test('drops a response from a replaced session or after a newer read', async () => {
    const pending: Array<ReturnType<typeof deferred<ProviderCatalogRead>>> = [];
    const store = createProviderCatalogStore(() => ({
      read: () => {
        const next = deferred<ProviderCatalogRead>();
        pending.push(next);
        return next.promise;
      },
    }));
    const oldSession = session(owner('gemini-primary', 1));
    const newSession = session(owner('gemini-primary', 2));
    const oldRead = store.getState().ensure(oldSession);
    const newRead = store.getState().ensure(newSession);
    const empty = { ...golden(), providers: [] };
    pending[1].resolve({ status: 'changed', catalog: empty, etag: null });
    await newRead;
    pending[0].resolve({ status: 'changed', catalog: golden(), etag: null });
    await oldRead;
    expect(selectSourceCatalog(store.getState(), oldSession.owner)).toBeUndefined();
    expect(usableCatalog(selectSourceCatalog(store.getState(), newSession.owner))).toEqual(empty);
  });

  test('drops a response whose session ended, and reads again on the next ensure', async () => {
    let calls = 0;
    const gate = deferred<ProviderCatalogRead>();
    const store = createProviderCatalogStore(() => ({
      read: () =>
        ++calls === 1
          ? gate.promise
          : Promise.resolve({
              status: 'changed' as const,
              catalog: golden(),
              etag: null,
            }),
    }));
    const lease = new AbortController();
    const o = owner();
    const first = store.getState().ensure(session(o, lease));
    lease.abort();
    gate.resolve({ status: 'changed', catalog: golden(), etag: null });
    await first;
    expect(selectSourceCatalog(store.getState(), o)?.status).toBe('loading');
    await store.getState().ensure(session(o));
    expect(selectSourceCatalog(store.getState(), o)?.status).toBe('ready');
    expect(calls).toBe(2);
  });

  test('reset forgets every slice and ignores reads still in flight', async () => {
    const gate = deferred<ProviderCatalogRead>();
    const store = createProviderCatalogStore(() => ({ read: () => gate.promise }));
    const s = session();
    const read = store.getState().ensure(s);
    store.getState().reset();
    gate.resolve({ status: 'changed', catalog: golden(), etag: null });
    await read;
    expect(store.getState().sources).toEqual({});
  });
});

describe('catalog-driven OAuth tiles', () => {
  const API_BASE = 'http://127.0.0.1:8317';

  test('keeps built-in presentation and adds discovered providers with a fallback icon', () => {
    const cards = buildCatalogOAuthProviderCards(golden(), API_BASE);
    expect(cards.map((card) => [card.kind, card.id])).toEqual([
      ['builtin', 'antigravity'],
      ['plugin', 'example-plugin'],
    ]);
    const builtIn = cards[0];
    expect(builtIn).toMatchObject({
      ...OAUTH_PROVIDERS.find((card) => card.id === 'antigravity'),
      awaitingAuth: false,
    });
    expect(cards[1]).toEqual({
      kind: 'plugin',
      id: 'example-plugin',
      title: 'Example Provider',
      icon: `${API_BASE}/v0/resource/plugins/example-provider-plugin/logo.svg`,
      flow: 'device',
      manualCallback: true,
      webui: false,
      awaitingAuth: true,
    });

    const noLogo = golden();
    const entries = noLogo.providers.map((entry) =>
      entry.id === 'example-plugin' ? { ...entry, logo: null } : entry
    );
    const [, discovered] = buildCatalogOAuthProviderCards(
      { ...noLogo, providers: entries },
      API_BASE
    );
    // An empty icon renders BrandGlyph's plug fallback.
    expect(discovered.kind === 'plugin' && discovered.icon).toBe('');
  });

  test('a plugin whose id folds onto a built-in keeps its own tile and id', () => {
    const plugin = golden().providers[1];
    const catalog: ProviderCatalog = {
      ...golden(),
      providers: [{ ...plugin, id: 'grok', displayName: 'Grok plugin' }],
    };
    expect(
      buildCatalogOAuthProviderCards(catalog, API_BASE).map((card) => [card.kind, card.id])
    ).toEqual([['plugin', 'grok']]);
  });

  test('maps credential ids to built-in tiles and skips providers without an OAuth flow', () => {
    const base = golden().providers[0];
    const catalog: ProviderCatalog = {
      ...golden(),
      providers: [
        { ...base, id: 'claude', displayName: 'Claude' },
        { ...base, id: 'codex', displayName: 'Codex', oauth: null },
        { ...base, id: 'snake_case', displayName: 'Snake' },
        { ...base, id: 'muse', displayName: 'Muse', lifecycle: 'awaiting_auth' },
      ],
    };
    const cards = buildCatalogOAuthProviderCards(catalog, API_BASE);
    expect(cards.map((card) => card.id)).toEqual(['meta', 'anthropic']);
    expect(cards.find((card) => card.id === 'meta')?.awaitingAuth).toBe(true);
    expect(
      buildCatalogOAuthProviderCards(catalog, API_BASE, (id) => id !== 'claude').map(
        (card) => card.id
      )
    ).toEqual(['meta']);
  });

  test('takes manual-callback support for discovered providers from the catalog', () => {
    const discovered = (manualCallback?: boolean): OAuthProviderCard => ({
      kind: 'plugin',
      id: 'x',
      title: 'X',
      icon: '',
      manualCallback,
    });
    expect(supportsManualCallback(discovered(false))).toBe(false);
    expect(supportsManualCallback(discovered(true))).toBe(true);
    // Plugin-list cards (no catalog) keep accepting callbacks.
    expect(supportsManualCallback(discovered())).toBe(true);
  });

  test('asks for the web UI flow when the catalog says the provider supports it', async () => {
    const calls: unknown[][] = [];
    const management = {
      get: async (...args: unknown[]) => {
        calls.push(args);
        return { url: 'https://x.test', state: 's' };
      },
    } as unknown as ManagementTransport;
    const api = createOAuthApi({
      owner: owner(),
      signal: new AbortController().signal,
      management,
      assertCurrent: () => {},
    });
    await api.startAuth('example-plugin', undefined, { webui: true });
    await api.startAuth('example-plugin');
    expect(calls.map((call) => (call[1] as { params: unknown }).params)).toEqual([
      { provider: 'example-plugin', is_webui: true },
      { provider: 'example-plugin' },
    ]);
  });
});

describe('OAuth page with a hub catalog', () => {
  let list: ReturnType<typeof spyOn<typeof pluginsApi, 'list'>>;
  beforeEach(async () => {
    list = spyOn(pluginsApi, 'list').mockResolvedValue({
      pluginsEnabled: true,
      pluginsDir: 'plugins',
      plugins: [],
    });
    await providerSources.connect(
      'https://oauth-fixture.invalid',
      'synthetic-key',
      'https://app-fixture.invalid'
    );
  });
  afterEach(() => {
    providerSources.reset();
    Object.assign(useProviderCatalogStore.getInitialState(), { sources: {} });
    list.mockRestore();
  });

  const render = async () => {
    const instance = createInstance();
    await instance.init({ lng: 'en', resources: { en: { translation: en } } });
    return renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n: instance },
        createElement(
          MemoryRouter,
          null,
          createElement(SelectedSourceBoundary, { children: createElement(OAuthPage) })
        )
      )
    );
  };
  const seed = (slice: { status: 'ready' | 'unsupported'; catalog: ProviderCatalog | null }) => {
    const view = providerSources.getSnapshot().sources[0];
    const o = view.session!.owner;
    // Static rendering reads a zustand store's initial state.
    Object.assign(useProviderCatalogStore.getInitialState(), {
      sources: {
        [o.instanceId]: {
          ownerKey: JSON.stringify([o.instanceId, o.sessionEpoch, o.sourceGeneration]),
          etag: null,
          error: null,
          ...slice,
        },
      },
    });
  };

  test('builds tiles from the catalog and marks providers waiting for auth', async () => {
    seed({ status: 'ready', catalog: { ...golden(), acceptedProviders: null } });
    const markup = await render();
    expect(markup).toContain('>Antigravity</button>');
    expect(markup).toContain('>Example Provider</button>');
    expect(markup).toContain(en.provider_catalog.awaiting_auth);
    // Providers the catalog does not list are not offered.
    expect(markup).not.toContain('>Codex</button>');
    expect(markup).not.toMatch(/provider_catalog\.|auth_login\./);
    // Two catalog tiles + Vertex + SIWC.
    expect(markup.match(/aria-haspopup="dialog"/g)?.length).toBe(4);
  });

  test('drops providers this hub does not accept', async () => {
    seed({ status: 'ready', catalog: { ...golden(), acceptedProviders: ['antigravity'] } });
    const markup = await render();
    expect(markup).toContain('>Antigravity</button>');
    expect(markup).not.toContain('Example Provider');
  });

  test('falls back to the static built-in tiles when the hub has no catalog route', async () => {
    seed({ status: 'unsupported', catalog: null });
    const markup = await render();
    expect(markup).not.toContain(en.provider_catalog.awaiting_auth);
    expect(markup.match(/aria-haspopup="dialog"/g)?.length).toBe(OAUTH_PROVIDERS.length + 2);
  });
});

describe('OAuth flows are pinned to the hub that started them', () => {
  const source = readFileSync(
    join(import.meta.dir, '../src/features/oauth/hooks/useOAuthFlows.ts'),
    'utf8'
  );

  test('resolves the destination only when a login starts', () => {
    // The single call, in startAuth.
    expect(source.match(/destinationOf\(provider\)/g)?.length).toBe(1);
    const start = source.slice(source.indexOf('const startAuth = async'));
    expect(start.slice(0, start.indexOf('const setCallbackInput'))).toContain(
      'pinned.current.set(provider, destination)'
    );
  });

  test('sends poll, cancel and callback to the pinned session and invalidates that hub', () => {
    for (const call of ['getAuthStatus', 'cancelSession', 'submitCallback', 'startAuth']) {
      expect(source).toMatch(new RegExp(`pinnedApi\\(destination\\)\\.${call}\\(`));
    }
    expect(source).not.toMatch(/createOAuthApi\(destinationOf/);
    expect(source).toContain('void invalidateProviderCatalog(destination);');
    expect(source).toContain("void notifyAuthFilesChanged(destination.owner, { reason: 'add' });");
  });
});

describe('Auth Files: providers waiting for auth', () => {
  const catalog = golden();

  test('lists accepted providers without credentials, until a credential appears', () => {
    expect(awaitingAuthProviders(catalog, undefined, []).map((entry) => entry.id)).toEqual([
      'example-plugin',
    ]);
    expect(
      awaitingAuthProviders(catalog, undefined, [{ name: 'a.json', type: 'example-plugin' }])
    ).toEqual([]);
    // Files not read yet: no placeholders that might flash away.
    expect(awaitingAuthProviders(catalog, undefined, undefined)).toEqual([]);
    expect(awaitingAuthProviders(null, undefined, [])).toEqual([]);
  });

  test('scopes by accepted providers; an open hub adds plugins no other source declares', () => {
    const builtInAwaiting = {
      ...catalog.providers[0],
      id: 'codex',
      lifecycle: 'awaiting_auth' as const,
    };
    const open: ProviderCatalog = {
      ...catalog,
      acceptedProviders: null,
      providers: [...catalog.providers, builtInAwaiting],
    };
    expect(awaitingAuthProviders(open, undefined, []).map((entry) => entry.id)).toEqual([
      'example-plugin',
    ]);
    // A baked provider list does not hide a newly installed plugin on an open hub...
    expect(awaitingAuthProviders(open, ['codex'], []).map((entry) => entry.id)).toEqual([
      'example-plugin',
      'codex',
    ]);
    // ...unless another source declares that provider.
    expect(
      awaitingAuthProviders(open, ['codex'], [], ['example-plugin']).map((entry) => entry.id)
    ).toEqual(['codex']);
    expect(
      awaitingAuthProviders(
        { ...open, acceptedProviders: ['codex', 'example-plugin'] },
        [],
        []
      ).map((entry) => entry.id)
    ).toEqual(['example-plugin', 'codex']);
  });

  test('an upload-only plugin waiting for its first credential still shows on Auth Files', () => {
    const quotaOnly = {
      ...catalog.providers[1],
      id: 'quota-only',
      source: 'plugin' as const,
      lifecycle: 'awaiting_auth' as const,
      oauth: null,
    };
    const open: ProviderCatalog = { ...catalog, acceptedProviders: null, providers: [quotaOnly] };
    expect(awaitingAuthProviders(open, [], []).map((entry) => entry.id)).toEqual(['quota-only']);
  });

  test('ownership uses exact ids: a grok plugin is not the xAI provider another hub owns', () => {
    const grok = {
      ...catalog.providers[1],
      id: 'grok',
      source: 'plugin' as const,
      lifecycle: 'awaiting_auth' as const,
    };
    const open: ProviderCatalog = { ...catalog, acceptedProviders: null, providers: [grok] };
    expect(awaitingAuthProviders(open, [], [], ['xai']).map((entry) => entry.id)).toEqual(['grok']);
    expect(awaitingAuthProviders(open, [], [], ['grok'])).toEqual([]);
  });

  test('placeholders follow the provider tab and search, never a credential-state chip', () => {
    const entry = catalog.providers[1];
    const filters = { provider: 'all', statusFilterMode: 'all' as const, search: '' };
    expect(awaitingMatchesFilters(entry, filters)).toBe(true);
    expect(awaitingMatchesFilters(entry, { ...filters, provider: 'example-plugin' })).toBe(true);
    expect(awaitingMatchesFilters(entry, { ...filters, provider: 'codex' })).toBe(false);
    expect(awaitingMatchesFilters(entry, { ...filters, statusFilterMode: 'problem' })).toBe(false);
    expect(awaitingMatchesFilters(entry, { ...filters, search: 'EXAMPLE prov' })).toBe(true);
    expect(awaitingMatchesFilters(entry, { ...filters, search: 'kiro' })).toBe(false);
  });

  test('the page unions placeholders into the tabs and each hub renders them in place', () => {
    // Static rendering shows only skeletons (no effects run), so the wiring is checked in source.
    const page = readFileSync(
      join(import.meta.dir, '../src/features/authFiles/AuthFilesPage.tsx'),
      'utf8'
    );
    const content = readFileSync(
      join(import.meta.dir, '../src/features/authFiles/AuthFilesSourceContent.tsx'),
      'utf8'
    );
    expect(page).toContain('...scopedAwaiting.map(catalogProviderKey)');
    expect(page).toContain('scopedAwaiting.length === 0 &&');
    expect(page).toContain('awaiting={awaitingBySource[view.source.instanceId]}');
    expect(content).toContain("listState === 'empty' && shownAwaiting.length === 0");
    expect(content).toContain('<AwaitingAuthCard');
    expect(content).toContain('onSignIn={entry.oauth ? openOAuth : null}');
  });

  test('renders the placeholder card with sign-in and upload actions', () => {
    const render = (onSignIn: (() => void) | null) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(AwaitingAuthCard, {
            label: 'Example Provider',
            iconSrc: null,
            compact: false,
            onSignIn,
            onUpload: () => {},
            disabled: false,
          })
        )
      );
    const t = i18n.getFixedT('en');
    void i18n.changeLanguage('en');
    const markup = render(() => {});
    expect(markup).toContain('data-lifecycle="awaiting_auth"');
    expect(markup).toContain('>Example Provider</h4>');
    expect(markup).toContain(t('provider_catalog.awaiting_auth'));
    expect(markup).toContain(t('provider_catalog.connect_action'));
    expect(markup).toContain(t('provider_catalog.upload_action'));
    expect(markup).not.toMatch(/provider_catalog\./);
    // Without an OAuth flow only an upload can activate the provider.
    const uploadOnly = render(null);
    expect(uploadOnly).not.toContain(`>${t('provider_catalog.connect_action')}</button>`);
    expect(uploadOnly).toContain(t('provider_catalog.upload_action'));
  });
});

describe('normalized quota through POST /quota/fetch', () => {
  const config = createPluginQuotaConfig(testQuotaDependencies);
  let list: ReturnType<typeof spyOn<typeof pluginsApi, 'list'>>;
  beforeEach(() => {
    config.resetRouteCache();
    list = spyOn(pluginsApi, 'list').mockResolvedValue({
      pluginsEnabled: true,
      pluginsDir: 'plugins',
      plugins: [],
    });
  });
  afterEach(() => {
    list.mockRestore();
    config.resetRouteCache();
  });

  const payload = {
    summary: [{ key: 'balance', label: 'Balance', value: 3 }],
    groups: [
      {
        displayName: 'Credits',
        buckets: [{ id: 'monthly', window: 'monthly', remainingFraction: 0.5, scope: 'account' }],
      },
    ],
  };

  test('reads any quota-capable credential by auth index, without plugin discovery', async () => {
    const post = spyOn(apiClient, 'post').mockResolvedValue(payload);
    try {
      // No quota provider or plugin id: the old heuristic could not route this credential.
      const data = await config.fetchQuota(
        { name: 'new.json', type: 'example-plugin', supportsQuota: true, authIndex: '7' },
        i18n.t
      );
      expect(post.mock.calls).toEqual([['/quota/fetch', { auth_index: '7' }]]);
      expect(list).not.toHaveBeenCalled();
      expect(data.summary).toEqual([
        {
          key: 'balance',
          label: 'Balance',
          value: 3,
          unit: undefined,
          format: undefined,
          currency: undefined,
        },
      ]);
      expect(data.groups[0].buckets[0]).toMatchObject({ remainingFraction: 0.5 });
    } finally {
      post.mockRestore();
    }
  });

  test('falls back to the plugin route on an older ProxD and remembers the missing route', async () => {
    const post = spyOn(apiClient, 'post').mockImplementation(((url: string) =>
      url === '/quota/fetch'
        ? Promise.reject(httpError(404))
        : Promise.resolve(payload)) as typeof apiClient.post);
    try {
      const file = { name: 'k.json', authIndex: '7', quotaPluginId: 'kiro-quota' };
      await config.fetchQuota(file, i18n.t);
      await config.fetchQuota(file, i18n.t);
      expect(post.mock.calls.map((call) => call[0])).toEqual([
        '/quota/fetch',
        '/plugins/kiro-quota/quota',
        '/plugins/kiro-quota/quota',
      ]);
    } finally {
      post.mockRestore();
    }
  });

  test('a handler 404 (credential gone) falls back once without disabling the route', async () => {
    const post = spyOn(apiClient, 'post').mockImplementation(((url: string) =>
      url === '/quota/fetch'
        ? Promise.reject(httpError(404, 'auth not found'))
        : Promise.reject(httpError(404, 'auth not found'))) as typeof apiClient.post);
    try {
      const file = { name: 'k.json', authIndex: '7', quotaPluginId: 'kiro-quota' };
      await expect(config.fetchQuota(file, i18n.t)).rejects.toThrow('HTTP 404');
      await expect(config.fetchQuota(file, i18n.t)).rejects.toThrow('HTTP 404');
      expect(post.mock.calls.map((call) => call[0])).toEqual([
        '/quota/fetch',
        '/plugins/kiro-quota/quota',
        '/quota/fetch',
        '/plugins/kiro-quota/quota',
      ]);
    } finally {
      post.mockRestore();
    }
  });

  test('reports other failures without trying another route', async () => {
    const post = spyOn(apiClient, 'post').mockRejectedValue(httpError(502));
    try {
      await expect(
        config.fetchQuota({ name: 'k.json', authIndex: '7', quotaPluginId: 'kiro-quota' }, i18n.t)
      ).rejects.toThrow('HTTP 502');
      expect(post).toHaveBeenCalledTimes(1);
    } finally {
      post.mockRestore();
    }
  });
});
