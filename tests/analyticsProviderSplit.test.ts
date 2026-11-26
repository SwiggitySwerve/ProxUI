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
          buckets: [0, 1, 2].map((hour) => ({ at: from + hour * HOUR, measured: hour !== 2 })),
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
    // A quiet bucket reads as no tokens; an unmeasured one says so and is hatched, not zero.
    expect(markup).toContain('data-state="gap"');
  });
});

describe('tokens by provider at scale and in the table', () => {
  const DAY = 24 * HOUR;
  const chart = (hours: number, measured = (i: number) => i !== 1) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ProviderStackChart, {
          title: 'Tokens by provider',
          split: [part('claude', 0, 10)],
          buckets: Array.from({ length: hours }, (_, i) => ({
            at: from + i * HOUR,
            measured: measured(i),
          })),
          interval: HOUR,
          label: (provider) => provider.toUpperCase(),
        })
      )
    );

  test('many bars drop their gaps; a day of hours keeps them', () => {
    expect(chart(30 * 24)).toContain('data-dense="true"');
    expect(chart(24)).not.toContain('data-dense');
  });

  test('hours over several days are labelled with the date at UTC midnights', () => {
    const markup = chart(3 * 24);
    const ticks = markup.slice(markup.lastIndexOf('<div', markup.indexOf('Jan 2<')));
    for (const day of ['Jan 2', 'Jan 3', 'Jan 4']) expect(ticks).toContain(`>${day}</span>`);
    expect(markup).not.toMatch(/>\d\d:\d\d<\/span>/);
    expect(from % DAY).toBe(0);
  });

  test('the table mounts its rows only when first opened', () => {
    const markup = chart(3);
    const table = markup.slice(markup.indexOf('<table'));
    expect(table).toContain('<th scope="col">CLAUDE</th>');
    expect(table).not.toContain('<th scope="row">');
  });

  test('a rolling day (25 hourly slots) keeps hour labels; longer windows name dates', () => {
    const markup = chart(25);
    expect(markup).toMatch(/>\d\d:\d\d<\/span>/);
    expect(markup).not.toContain('>Jan 2</span>');
  });
});

test('the UI fixture split adds up to its timeline in every counter, zero scenario included', async () => {
  const { analyticsScenario } = await import('./fixtures/analyticsUi');
  const { rangeQuery } = await import('../src/features/analytics/queryState');
  for (const scenario of ['ready', 'zero'] as const) {
    const data = analyticsScenario(scenario, rangeQuery('24h', Date.UTC(2026, 9, 29, 12)));
    for (const point of data.timeline) {
      const parts = data.provider_timeline!.filter((p) => p.bucket_ms === point.bucket_ms);
      for (const key of ['calls', 'failure_calls', 'total_tokens', 'reasoning_tokens'] as const)
        expect(parts.reduce((sum, p) => sum + p[key], 0)).toBe(point[key]);
    }
  }
});
