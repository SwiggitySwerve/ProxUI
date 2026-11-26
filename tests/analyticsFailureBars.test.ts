import { beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { AnalyticsChart } from '../src/features/analytics/AnalyticsChart';
import { AnalyticsViews } from '../src/features/analytics/AnalyticsViews';
import { analyticsUiResponse } from './fixtures/analyticsUi';

const noop = () => {};
beforeEach(async () => {
  await i18n.changeLanguage('en');
});

const chart = (data: Parameters<typeof AnalyticsChart>[0]['data']) =>
  renderToStaticMarkup(
    createElement(AnalyticsChart, {
      title: 'By provider',
      // Provider rows: each takes the colour of the provider it names.
      data: data.map((d) => ({ ...d, provider: d.key })),
      onSelect: noop,
      failures: { onSelect: noop },
    })
  );

describe('failure bars', () => {
  test('failed events are a hatched part from the start of the bar, on the one shared scale', () => {
    const markup = chart([
      { key: 'claude', label: 'Claude', value: 200, failed: 50 },
      { key: 'codex', label: 'GPT / Codex', value: 100, failed: 0 },
    ]);
    // Claude: 50 of the 200 maximum failed, 150 did not.
    // CSS modules have no class names under test: the failed part is the unfilled first span.
    expect(markup).toContain(
      '<span data-split="true" aria-hidden="true"><span style="width:25%"></span>' +
        '<span style="width:75%;background:var(--claude-fill)"></span></span>'
    );
    // Codex has no failed part and half the width.
    expect(markup).toContain(
      '<span data-split="true" aria-hidden="true"><span style="width:50%;background:var(--codex-fill)"></span></span>'
    );
  });

  test('the failed count opens those events; a row without failures has no such action', () => {
    const markup = chart([
      { key: 'claude', label: 'Claude', value: 200, failed: 50 },
      { key: 'codex', label: 'GPT / Codex', value: 100, failed: 0 },
    ]);
    // Visible text first, then the row it belongs to, read by screen readers only.
    expect(markup).toMatch(
      /<button[^>]*title="50"[^>]*>50 failed <span[^>]*>for Claude<\/span><\/button>/
    );
    expect(markup).not.toContain('for GPT / Codex');
    expect(markup).toContain('0 failed');
    // The name's button names both counts, so a screen reader hears what the bar shows.
    expect(markup).toContain('aria-label="Claude: 200 events, 50 failed"');
  });

  test('no button is nested in another, and the table repeats the failed column', () => {
    const markup = chart([{ key: 'claude', label: 'Claude', value: 200, failed: 50 }]);
    expect(markup).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<button/s);
    expect(markup).toContain('<th scope="col">Failed events</th>');
  });

  test('a failed count above the total never draws past the bar', () => {
    const markup = chart([{ key: 'x', label: 'X', value: 10, failed: 12 }]);
    expect(markup).toContain(
      '<span data-split="true" aria-hidden="true"><span style="width:100%"></span><span style="width:0%"></span>'
    );
  });

  test('only provider rows take a provider colour; a model named like a provider does not', () => {
    const markup = renderToStaticMarkup(
      createElement(AnalyticsChart, {
        title: 'By model',
        data: [{ key: 'gemini', label: 'gemini', value: 3 }],
      })
    );
    expect(markup).not.toContain('--gemini-');
  });

  test('a model served by one provider takes its colour; one served by several stays neutral', () => {
    const data = {
      ...analyticsUiResponse,
      models: [
        { ...analyticsUiResponse.models[0], key: 'solo', label: 'solo', providers: ['codex'] },
        {
          ...analyticsUiResponse.models[0],
          key: 'shared',
          label: 'shared',
          providers: ['claude', 'codex'],
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(AnalyticsViews, {
        tab: 'overview',
        data,
        onBucket: noop,
        onModel: noop,
        onProvider: noop,
        onShowHourly: noop,
      })
    );
    const byModel = markup.slice(markup.indexOf('By model'));
    const row = (name: string) =>
      byModel.slice(byModel.indexOf(`title="${name}"`), byModel.indexOf(`title="${name}"`) + 200);
    expect(row('solo')).toContain('var(--codex-color)');
    expect(row('shared')).not.toContain('-color)');
  });

  const views = (failures: boolean, tab: 'overview' | 'tokens' = 'overview') =>
    renderToStaticMarkup(
      createElement(AnalyticsViews, {
        tab,
        data: analyticsUiResponse,
        onBucket: noop,
        onModel: noop,
        onProvider: noop,
        failures: failures ? { onModel: noop, onProvider: noop } : undefined,
      })
    );

  test('Overview splits events by outcome; an outcome filter or another tab does not', () => {
    const overview = views(true);
    expect(overview).toContain('By provider · Events and failures');
    expect(overview).toContain('By model · Events and failures');
    expect(overview).toContain('8 failed <span>for Claude</span>');

    const filtered = views(false);
    expect(filtered).toContain('By provider · Retained events');
    expect(filtered).not.toContain('data-split');
    expect(filtered).not.toContain(' failed <span>');

    const tokens = views(true, 'tokens');
    expect(tokens).not.toContain('Events and failures');
    expect(tokens).not.toContain('data-split');
  });
});
