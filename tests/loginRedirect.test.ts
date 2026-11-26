import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolveLoginRedirect } from '../src/router/redirectTarget';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('resolveLoginRedirect', () => {
  test('keeps the pathname, query and hash of the page that sent the user to login', () => {
    const from = {
      pathname: '/analytics',
      search: '?tab=overview&range=7d&bucket=hour',
      hash: '#x',
    };
    expect(resolveLoginRedirect({ from })).toEqual({
      to: '/analytics?tab=overview&range=7d&bucket=hour#x',
    });
  });

  test('falls back to the dashboard when there is nothing usable', () => {
    expect(resolveLoginRedirect(null)).toEqual({ to: '/' });
    expect(resolveLoginRedirect({})).toEqual({ to: '/' });
    expect(resolveLoginRedirect({ from: { pathname: 42 } })).toEqual({ to: '/' });
  });

  test('stays in the app: no other origin, no login loop', () => {
    for (const pathname of [
      '//evil.example',
      'https://evil.example',
      '/\\evil.example',
      '/login',
      '/login/',
      '/login//',
      '/LOGIN',
    ]) {
      expect(resolveLoginRedirect({ from: { pathname, search: '?a=1' } })).toEqual({ to: '/' });
    }
  });

  test('ignores a search or hash that is not shaped like one', () => {
    expect(
      resolveLoginRedirect({ from: { pathname: '/analytics', search: 'x', hash: 'y' } })
    ).toEqual({ to: '/analytics' });
  });

  test('carries a validated Auth Files credential pin across /login (case, slash and encoded variants) and strips extra fields', () => {
    for (const pathname of [
      '/auth-files',
      '/auth-files/',
      '/AUTH-FILES',
      '/AUTH-FILES/',
      '/auth%2Dfiles',
    ]) {
      expect(
        resolveLoginRedirect({
          from: {
            pathname,
            state: {
              pinnedCredential: { source: ' claude-primary ', authIndex: '' },
              extra: 'ignored',
            },
          },
        })
      ).toEqual({
        to: pathname,
        state: { pinnedCredential: { source: 'claude-primary', authIndex: '' } },
      });
    }
  });

  test('drops router state for other routes, invalid targets, or malformed pins', () => {
    expect(
      resolveLoginRedirect({
        from: {
          pathname: '/auth-files/models',
          state: { pinnedCredential: { source: 'claude-primary', authIndex: '1' } },
        },
      })
    ).toEqual({ to: '/auth-files/models' });
    expect(
      resolveLoginRedirect({
        from: {
          pathname: '/analytics',
          state: { pinnedCredential: { source: 'claude-primary', authIndex: '1' } },
        },
      })
    ).toEqual({ to: '/analytics' });
    expect(
      resolveLoginRedirect({
        from: {
          pathname: '//evil.example',
          state: { pinnedCredential: { source: 'claude-primary', authIndex: '1' } },
        },
      })
    ).toEqual({ to: '/' });
    expect(
      resolveLoginRedirect({
        from: { pathname: '/auth-files', state: { pinnedCredential: { source: 123 } } },
      })
    ).toEqual({ to: '/auth-files' });
  });
});

describe('LoginPage redirects', () => {
  const page = read('src/pages/LoginPage.tsx');

  test('a restored session navigates at once instead of waiting on a splash timer', () => {
    expect(page).not.toMatch(/setTimeout/);
  });

  test('no post-login redirect drops the query by reading only the pathname', () => {
    expect(page).not.toMatch(/\.from\?\.pathname/);
  });
});
