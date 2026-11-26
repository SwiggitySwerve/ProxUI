import { beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../src/i18n';
import { ProviderStackChart } from '../src/features/analytics/ProviderStackChart';
import type { AnalyticsProviderBucket } from '../src/domain/analytics/types';

const HOUR = 3_600_000;
const from = Date.UTC(2026, 0, 2);
const part = (provider: string, hour: number, total: number): AnalyticsProviderBucket => ({
  provider,
  bucket_ms: from + hour * HOUR,
  calls: 1,
  failure_calls: 0,
  input_tokens: total,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: total,
});
beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('tokens by provider', () => {
  const render = (split: AnalyticsProviderBucket[]) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ProviderStackChart, {
          title: 'Tokens by provider',
          split,
          buckets: [0, 1, 2].map((hour) => from + hour * HOUR),
          from,
          to: from + 3 * HOUR,
          interval: HOUR,
          label: (provider) => provider.toUpperCase(),
        })
      )
    );

  test('providers without a colour share one Other part, listed last; named ones open Quota', () => {
    const markup = render([
      part('xai', 0, 50),
      part('kimi', 0, 50),
      part('codex', 0, 300),
      part('claude', 1, 200),
    ]);
    const legend = markup.slice(markup.indexOf('<ul'), markup.indexOf('</ul>'));
    expect([...legend.matchAll(/>([A-Za-z]+)<\/(?:a|li)>/g)].map((m) => m[1])).toEqual([
      'CODEX',
      'CLAUDE',
      'Other',
    ]);
    expect(legend).toContain('href="/quota?provider=codex"');
    expect(legend).not.toContain('href="/quota?provider=xai"');
    // The table keeps every provider apart.
    for (const name of ['XAI', 'KIMI']) expect(markup).toContain(`<th scope="col">${name}</th>`);
  });

  test('bars only show: every bucket keeps its place, none is a control', () => {
    const markup = render([part('claude', 0, 10)]);
    expect(markup.match(/data-at=/g)).toHaveLength(3);
    const plot = markup.slice(markup.indexOf('data-at='), markup.indexOf('<output'));
    expect(plot).not.toContain('<button');
  });
});
