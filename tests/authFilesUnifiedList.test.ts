import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import { readFileSync } from 'node:fs';
import en from '@/i18n/locales/en.json';
import { AuthFilesSourceNav } from '@/features/authFiles/components/AuthFilesSourceNav';
import { filterAuthFiles, groupByProvider, listLoadState } from '@/features/authFiles/unifiedList';
import type { SourceView } from '@/services/providerSources/registry';
import type { AuthFileItem } from '@/types';

const file = (name: string, type: string, extra: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name,
  type,
  email: `${name}@example.invalid`,
  ...extra,
});
const FILES = [
  file('b-claude', 'claude'),
  file('a-codex', 'codex', { disabled: true }),
  file('c-claude', 'claude', { status: 'error', statusMessage: 'unauthorized' }),
  file('d-codex', 'codex'),
];
const all = { provider: 'all', statusFilterMode: 'all' as const, search: '' };

describe('one filter set for every source', () => {
  test('provider, status and search combine', () => {
    expect(filterAuthFiles(FILES, { ...all, provider: 'codex' }).map((f) => f.name)).toEqual([
      'a-codex',
      'd-codex',
    ]);
    expect(
      filterAuthFiles(FILES, { ...all, statusFilterMode: 'disabled' }).map((f) => f.name)
    ).toEqual(['a-codex']);
    // The Active chip counts like countCredentials: c-claude has a problem, so it is not active.
    expect(
      filterAuthFiles(FILES, { ...all, statusFilterMode: 'enabled', search: 'claude' }).map(
        (f) => f.name
      )
    ).toEqual(['b-claude']);
  });

  test('grouping keeps the sort inside each provider and orders providers alphabetically', () => {
    expect(groupByProvider(FILES).map((f) => f.name)).toEqual([
      'b-claude',
      'c-claude',
      'a-codex',
      'd-codex',
    ]);
  });
});

describe('credential list load state (machine M1, characterization)', () => {
  const cases: Array<[Parameters<typeof listLoadState>[0], string]> = [
    [{ loading: true, refreshing: false, error: '', fileCount: 0 }, 'loading'],
    // useAuthFilesData keeps old files on a failed reload: named, not hidden.
    [{ loading: false, refreshing: false, error: 'boom', fileCount: 3 }, 'error-stale'],
    [{ loading: false, refreshing: false, error: 'boom', fileCount: 0 }, 'error'],
    [{ loading: false, refreshing: true, error: '', fileCount: 3 }, 'refreshing'],
    [{ loading: false, refreshing: false, error: '', fileCount: 0 }, 'empty'],
    [{ loading: false, refreshing: false, error: '', fileCount: 2 }, 'ready'],
    // loading wins over a stale error flag (a new foreground read clears the error first).
    [{ loading: true, refreshing: true, error: 'boom', fileCount: 2 }, 'loading'],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${expected}`, () =>
      expect(listLoadState(input)).toBe(expected));
  }

  test('each source group exposes the state to tests and agents', () => {
    const page =
      readFileSync('src/features/authFiles/AuthFilesPage.tsx', 'utf8') +
      readFileSync('src/features/authFiles/AuthFilesSourceContent.tsx', 'utf8');
    expect(page).toContain('data-machine="auth-files-list" data-state={listState}');
  });
});

describe('source filter', () => {
  const view = (instanceId: string, label: string) =>
    ({ source: { instanceId, label } }) as unknown as SourceView;
  const render = (active: string) => {
    const i18n = createInstance({ lng: 'en', resources: { en: { translation: en } } });
    void i18n.init();
    return renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(AuthFilesSourceNav, {
          sources: [view('alpha', 'Claude hub'), view('beta', 'GPT hub')],
          counts: { all: 6, alpha: 4, beta: 2 },
          active,
          onChange: () => {},
        })
      )
    );
  };

  test('offers all sources and each source with its count; the active one is pressed', () => {
    const html = render('beta');
    expect(html).toContain('All sources');
    expect(html).toMatch(/aria-pressed="true"[^>]*>GPT hub<span[^>]*>2<\/span>/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Claude hub<span[^>]*>4<\/span>/);
  });

  test('the page has one filter bar, not one per source', () => {
    const page =
      readFileSync('src/features/authFiles/AuthFilesPage.tsx', 'utf8') +
      readFileSync('src/features/authFiles/AuthFilesSourceContent.tsx', 'utf8');
    expect(page.match(/<AuthFilesToolbar/g)).toHaveLength(1);
    expect(page.match(/<ProviderTabs/g)).toHaveLength(1);
    expect(page).not.toContain('OAuthExcludedCard');
  });
});

describe('one credential from a link', () => {
  test('shows exactly that auth index, so "Delete shown" never reaches a similar name', async () => {
    const {
      deletableShown,
      forSource,
      readPinnedCredentialFromParams,
      readPinnedCredentialFromState,
    } = await import('@/features/authFiles/unifiedList');
    const { awaitingMatchesFilters } = await import('@/features/authFiles/awaitingProviders');
    const files = [
      file('dave.json', 'claude', { authIndex: 'claude-dave' }),
      file('backup-dave.json', 'claude', { authIndex: 'claude-backup' }),
      file('star*.json', 'claude', { authIndex: 'claude-star' }),
    ];
    // The search box holds the file name as a label; the auth index decides.
    const page = {
      ...all,
      search: 'dave.json',
      sortMode: 'default' as const,
      compactMode: false,
      pageSize: 9,
      source: 'claude-primary',
      revision: 0,
      credential: { source: 'claude-primary', authIndex: 'claude-dave' },
    };
    const here = forSource(page, 'claude-primary');
    expect(filterAuthFiles(files, here).map((f) => f.name)).toEqual(['dave.json']);
    expect(deletableShown(files, here).map((f) => f.name)).toEqual(['dave.json']);
    expect(filterAuthFiles(files, { ...all, search: 'dave.json' })).toHaveLength(2);
    // Another source shows nothing of it, even a credential with the same auth index.
    const elsewhere = forSource(page, 'claude-backup');
    expect(filterAuthFiles(files, elsewhere)).toEqual([]);
    expect(deletableShown(files, elsewhere)).toEqual([]);
    // A deleted or empty auth index matches nothing (and never falls back to search).
    const missing = forSource(
      { ...page, search: '', credential: { source: 'claude-primary', authIndex: 'deleted' } },
      'claude-primary'
    );
    expect(filterAuthFiles(files, missing)).toEqual([]);
    expect(deletableShown(files, missing)).toEqual([]);
    expect(filterAuthFiles(files, { ...all, match: { authIndex: '' } })).toEqual([]);
    // Wildcard characters in the filename label never hide the pinned credential.
    const star = forSource(
      {
        ...page,
        search: 'star*.json',
        credential: { source: 'claude-primary', authIndex: 'claude-star' },
      },
      'claude-primary'
    );
    expect(filterAuthFiles(files, star).map((f) => f.name)).toEqual(['star*.json']);
    // Placeholder awaiting-auth cards stay hidden while pinned to a credential.
    const placeholder = {
      id: 'claude',
      displayName: 'Claude',
      lifecycle: 'awaiting_auth' as const,
      credentialCount: 0,
      modelCount: 0,
      capabilities: [],
      authMethods: [],
    };
    expect(awaitingMatchesFilters(placeholder, here)).toBe(false);
    expect(awaitingMatchesFilters(placeholder, elsewhere)).toBe(false);
    // Incomplete pins (blank source or authIndex) still match nothing on every source.
    const blankIndex = forSource(
      { ...page, search: '', credential: { source: 'claude-primary', authIndex: '' } },
      'claude-primary'
    );
    expect(blankIndex.match).toBe('none');
    expect(filterAuthFiles(files, blankIndex)).toEqual([]);
    expect(deletableShown(files, blankIndex)).toEqual([]);
    const blankSource = forSource(
      { ...page, search: '', credential: { source: '', authIndex: 'claude-dave' } },
      'claude-primary'
    );
    expect(blankSource.match).toBe('none');
    expect(filterAuthFiles(files, blankSource)).toEqual([]);
    // Link parameters and browser history state preserve incomplete links as empty pins.
    expect(
      readPinnedCredentialFromParams(new URLSearchParams('source=claude-primary&auth_index=1'))
    ).toEqual({ source: 'claude-primary', authIndex: '1' });
    expect(readPinnedCredentialFromParams(new URLSearchParams(''))).toBeNull();
    expect(readPinnedCredentialFromParams(new URLSearchParams('source=claude-primary'))).toEqual({
      source: 'claude-primary',
      authIndex: '',
    });
    expect(
      readPinnedCredentialFromParams(new URLSearchParams('source=claude-primary&auth_index= '))
    ).toEqual({ source: 'claude-primary', authIndex: '' });
    expect(
      readPinnedCredentialFromState({
        pinnedCredential: { source: 'claude-primary', authIndex: '1' },
      })
    ).toEqual({ source: 'claude-primary', authIndex: '1' });
    expect(
      readPinnedCredentialFromState({
        pinnedCredential: { source: 'claude-primary', authIndex: '' },
      })
    ).toEqual({ source: 'claude-primary', authIndex: '' });
    expect(readPinnedCredentialFromState(null)).toBeNull();
    expect(readPinnedCredentialFromState({ pinnedCredential: { source: 'x' } })).toBeNull();
  });
});
