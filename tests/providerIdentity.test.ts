import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { providerFill, providerInk } from '../src/features/providers/identity';
import {
  connectedProviderPills,
  providerBarFill,
  providerColor,
} from '../src/features/dashboard/providerSelection';
import { poolProviderStyle } from '../src/features/quotaPool/providerPresentation';
import type { SourceView } from '../src/services/providerSources/registry';
import type { SourceSession } from '../src/services/api/sourceSession';

const root = new URL('..', import.meta.url).pathname;
const themes = readFileSync(join(root, 'src/styles/themes.scss'), 'utf8');

describe('provider identity', () => {
  test('Claude, Codex and Gemini have an ink and a fill; Antigravity shares Gemini', () => {
    expect(providerInk('claude')).toBe('var(--claude-color)');
    expect(providerInk('codex')).toBe('var(--codex-color)');
    expect(providerInk('gemini')).toBe('var(--gemini-color)');
    expect(providerInk('antigravity')).toBe('var(--gemini-color)');
    expect(providerFill('codex')).toBe('var(--codex-fill)');
    expect(providerFill('antigravity')).toBe('var(--gemini-fill)');
  });

  test('a provider without a hue is null, so each screen keeps its own neutral', () => {
    for (const id of ['xai', 'unknown', 'constructor', '__proto__', '', null, undefined]) {
      expect(providerInk(id)).toBeNull();
      expect(providerFill(id)).toBeNull();
    }
    expect(providerColor('xai')).toBe('var(--text-tertiary)');
    expect(providerBarFill(null)).toBe('var(--text-tertiary)');
  });

  test('every fill is defined; Codex, Gemini and failures carry a texture, not only a colour', () => {
    for (const token of ['claude', 'codex', 'gemini'])
      expect(themes).toMatch(new RegExp(`--${token}-fill:`));
    for (const token of ['--codex-fill', '--gemini-fill', '--viz-failure-fill'])
      expect(themes).toMatch(new RegExp(`${token}:\\s*(repeating-linear|radial)-gradient`));
  });

  test('Dashboard and Quota read the same identity, including Gemini', () => {
    const session = {} as SourceSession;
    const [pill] = connectedProviderPills(
      [
        {
          source: {
            instanceId: 'ag',
            label: 'Antigravity',
            publicBasePath: '/ag',
            aliases: [],
            authScope: 'scope',
            apiBase: 'https://prox.test/ag',
            providers: ['antigravity'],
          },
          session,
          status: 'ready',
          version: null,
          supportsPlugin: false,
        } satisfies SourceView,
      ],
      'Unattributed'
    );
    expect(providerColor(pill.brand)).toBe('var(--gemini-color)');
    expect(poolProviderStyle('antigravity').style).toEqual({
      '--pool-accent': 'var(--gemini-color)',
    });
    expect(poolProviderStyle('codex').style).toEqual({ '--pool-accent': 'var(--codex-color)' });
  });

  test('no screen outside the owner picks a provider hue itself', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(join(root, 'src'));
    const offenders = files.filter(
      (path) =>
        !path.endsWith('features/providers/identity.ts') &&
        /var\(--(claude|codex|gemini)-(color|fill)\)/.test(readFileSync(path, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });
});
