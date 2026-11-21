import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROVIDER_CATALOG_SCHEMA_VERSION,
  isValidProviderId,
  parseProviderCatalog,
} from '../src/domain/providerCatalog';

const GOLDEN_PATH = join(import.meta.dir, 'fixtures/providerCatalog/catalog.golden.json');
const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko'] as const;

describe('provider catalog wire contract', () => {
  test('parses the golden ProxD v8 catalog fixture', () => {
    const raw = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as unknown;
    const catalog = parseProviderCatalog(raw);
    expect(catalog).not.toBeNull();
    expect(catalog?.schemaVersion).toBe(PROVIDER_CATALOG_SCHEMA_VERSION);
    expect(catalog?.instanceId).toBe('gemini-primary');
    expect(catalog?.acceptedProviders).toEqual(['antigravity', 'example-plugin']);
    expect(catalog?.providers).toHaveLength(2);
    expect(catalog?.providers[0]).toMatchObject({
      id: 'antigravity',
      source: 'builtin',
      lifecycle: 'active',
      credentials: { total: 1, active: 1, disabled: 0, problem: 0 },
      oauth: { flow: 'browser', manualCallback: true, webui: true },
      quota: { supported: true, reader: 'builtin', supportsReset: false },
    });
    expect(catalog?.providers[1]).toMatchObject({
      id: 'example-plugin',
      source: 'plugin',
      pluginId: 'example-provider-plugin',
      lifecycle: 'awaiting_auth',
      credentials: { total: 0, active: 0, disabled: 0, problem: 0 },
      oauth: { flow: 'device', aliases: ['example'], domains: ['example.test'] },
      quota: {
        supported: true,
        reader: 'plugin',
        pluginId: 'example-provider-plugin',
        supportsReset: false,
      },
    });
  });

  test('validates provider slug ids and rejects malformed payloads', () => {
    expect(isValidProviderId('claude')).toBe(true);
    expect(isValidProviderId('kimi-ai')).toBe(true);
    expect(isValidProviderId('example_v2')).toBe(true);
    expect(isValidProviderId('')).toBe(false);
    expect(isValidProviderId('Claude')).toBe(false);
    expect(isValidProviderId('../evil')).toBe(false);
    expect(isValidProviderId('a'.repeat(65))).toBe(false);

    const raw = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, unknown>;
    expect(parseProviderCatalog({ ...raw, schema_version: 2 })).toBeNull();
    expect(parseProviderCatalog({ ...raw, instance_id: 'BAD_ID' })).toBeNull();
    expect(parseProviderCatalog({ ...raw, accepted_providers: ['claude', 'claude'] })).toBeNull();
    expect(
      parseProviderCatalog({
        ...raw,
        providers: [raw.providers && (raw.providers as unknown[])[0], (raw.providers as unknown[])[0]],
      })
    ).toBeNull();
  });

  test('an entry the parser cannot use is left out without losing the catalog', () => {
    const raw = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, unknown>;
    const entries = raw.providers as Record<string, unknown>[];
    const golden = parseProviderCatalog(raw)!;
    // e.g. a credential-bearing OpenAI-compatible config whose name is not a slug.
    const legacy = { ...entries[0], id: 'openai-compatible-my gateway' };
    const parsed = parseProviderCatalog({ ...raw, providers: [...entries, legacy, 'junk'] });
    expect(parsed?.providers).toEqual(golden.providers);
    expect(parsed?.instanceId).toBe(golden.instanceId);
  });

  test('auto-discovery i18n keys exist in all six locales', () => {
    const readLocale = (code: string) =>
      JSON.parse(
        readFileSync(join(import.meta.dir, `../src/i18n/locales/${code}.json`), 'utf8')
      ) as Record<string, Record<string, unknown>>;
    const en = readLocale('en');
    const catalogKeys = Object.keys(en.provider_catalog ?? {}).sort();
    expect(catalogKeys.length).toBeGreaterThan(0);
    for (const code of LOCALES) {
      const locale = readLocale(code);
      expect(Object.keys(locale.provider_catalog ?? {}).sort()).toEqual(catalogKeys);
    }
  });
});
