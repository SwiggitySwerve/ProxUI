import { beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../src/i18n';
import { RoutingView } from '../src/features/analytics/RoutingView';
import { analyticsScenario } from './fixtures/analyticsUi';
import { rangeQuery } from '../src/features/analytics/queryState';

const data = analyticsScenario('ready', rangeQuery('24h', Date.UTC(2026, 9, 29, 12)));
const render = (response = data, reveal = false) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(RoutingView, { data: response, reveal, onModel: () => {} })
    )
  );
beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('routing', () => {
  test('accounts are masked until Show emails is on, and open in Auth Files by source and index', () => {
    const masked = render();
    expect(masked).not.toContain('ada.lovelace@example.test');
    expect(masked).toContain('ada•••ce@ex•••.test');
    expect(masked).toContain('href="/auth-files?source=claude-primary&amp;auth_index=1"');
    // No source or index: nothing to open, and it says so.
    expect(masked).toContain('Not attributed');
    expect(render(data, true)).toContain('ada.lovelace@example.test');
  });

  test('busiest account first; cells name events and failures', () => {
    const markup = render();
    expect(markup.indexOf('ada•••')).toBeLessThan(markup.indexOf('gra•••'));
    expect(markup).toContain('title="96 events, 8 failed"');
    expect(markup).toContain('8 failed</small>');
  });

  test('a server without accounts says so instead of drawing an empty grid', () => {
    expect(render({ ...data, accounts: undefined, routes: undefined })).toContain(
      'This server does not report accounts yet.'
    );
  });
});

describe('request details follow Show emails', () => {
  test('the account label and credential file are masked until Show emails is on', async () => {
    const { RequestDetails } = await import('../src/features/analytics/RequestTable');
    const { analyticsUiRequest } = await import('./fixtures/analyticsUi');
    const request = {
      ...analyticsUiRequest,
      account_label: 'ada.lovelace@example.test',
      auth_file_snapshot: 'claude-ada.lovelace@example.test.json',
    };
    const masked = renderToStaticMarkup(createElement(RequestDetails, { request, reveal: false }));
    expect(masked).not.toContain('ada.lovelace@example.test');
    expect(masked).toContain('ada•••ce@ex•••.test');
    const shown = renderToStaticMarkup(createElement(RequestDetails, { request, reveal: true }));
    expect(shown).toContain('ada.lovelace@example.test');
  });
});
