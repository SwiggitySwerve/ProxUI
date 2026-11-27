import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { test, expect, type Page } from '@playwright/test';
import type { PoolDashboard, PoolPoint, QuotaPool } from '../../src/domain/quotaPool/types';

const origin = `http://127.0.0.1:${Number(process.env.PROX_UI_PORT ?? 15173)}`;
const config = parse(
  readFileSync(new URL('../fixtures/visualConfig-v8.yaml', import.meta.url), 'utf8')
);
const discovery = {
  schemaVersion: 1,
  revision: 'a'.repeat(64),
  defaultInstanceId: 'fixture-source',
  sources: [
    {
      instanceId: 'fixture-source',
      label: 'Synthetic source',
      publicBasePath: '',
      aliases: [],
      authScope: 'synthetic',
    },
  ],
};

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 26, 14, 0);
const FROM = NOW - 5 * DAY;
const TO = NOW + 10 * DAY;

const pt = (atMs: number, remaining: number | null, drain = 12, burn = 14): PoolPoint => ({
  atMs,
  remainingPoints: remaining,
  burnPointsPerHour: remaining === null ? null : burn,
  drainPointsPerHour: remaining === null ? null : drain,
});

function buildFixtureDashboard(includeExtraProviders = false): PoolDashboard {
  const recTimes = [0, 1, 2, 3, 4, 5].map((d) => FROM + d * DAY);
  const tReset1 = NOW + 2.5 * DAY; // Claude +1,840 & Codex +590 simultaneous
  const tEmpty = NOW + 4.2 * DAY; // Gemini empty, Claude +1,960
  const tGemini = NOW + 7.0 * DAY; // Gemini +1,940 alone
  const tClaude = NOW + 7.5 * DAY; // Claude +1,960 alone
  const tCodex = NOW + 9.0 * DAY; // Codex +480 alone

  const claudeRec = [
    pt(recTimes[0], 2400, 28, 30),
    pt(recTimes[1], 1400, 32, 34),
    pt(recTimes[2], 3200, -45, 22),
    pt(recTimes[3], 1800, 26, 28),
    pt(recTimes[4], 2600, -18, 20),
    pt(recTimes[5], 2160, 14, 14),
  ];
  const codexRec = [
    pt(recTimes[0], 880, 5, 5),
    pt(recTimes[1], 790, 4, 4),
    pt(recTimes[2], 710, 4, 4),
    pt(recTimes[3], 580, 6, 6),
    pt(recTimes[4], 740, -12, 4),
    pt(recTimes[5], 640, 4, 4),
  ];
  const geminiRec = [
    pt(recTimes[0], 1720, 8, 8),
    pt(recTimes[1], 1500, 9, 9),
    pt(recTimes[2], 1280, 9, 9),
    pt(recTimes[3], 1020, 11, 11),
    pt(recTimes[4], 1680, -25, 8),
    pt(recTimes[5], 1581.1, 8, 8),
  ];

  const claudeProj = [
    pt(NOW, 2160),
    pt(tReset1, 1510),
    pt(tReset1, 3350),
    pt(tEmpty, 2820),
    pt(tEmpty, 4780),
    pt(tGemini, 4200),
    pt(tGemini, 4200),
    pt(tClaude, 5892.5),
    pt(tClaude, 7852.5),
    pt(tCodex, 7200),
    pt(tCodex, 7200),
    pt(TO, 6900),
  ];
  const codexProj = [
    pt(NOW, 640),
    pt(tReset1, 160),
    pt(tReset1, 750),
    pt(tEmpty, 620),
    pt(tEmpty, 620),
    pt(tGemini, 640),
    pt(tGemini, 640),
    pt(tClaude, 613.7),
    pt(tClaude, 613.7),
    pt(tCodex, 340),
    pt(tCodex, 820),
    pt(TO, 740),
  ];
  const geminiProj = [
    pt(NOW, 1581.1),
    pt(tReset1, 620),
    pt(tReset1, 620),
    pt(tEmpty, 0),
    pt(tEmpty, 0),
    pt(tGemini, 0),
    pt(tGemini, 1940),
    pt(tClaude, 1818.1),
    pt(tClaude, 1818.1),
    pt(tCodex, 1240),
    pt(tCodex, 1240),
    pt(TO, 1020),
  ];

  const sumSeries = (seriesList: PoolPoint[][]): PoolPoint[] =>
    seriesList[0].map((p, i) => ({
      atMs: p.atMs,
      remainingPoints: Number(
        seriesList.reduce((acc, s) => acc + s[i].remainingPoints!, 0).toFixed(1)
      ),
      burnPointsPerHour:
        p.burnPointsPerHour !== null
          ? seriesList.reduce((acc, s) => acc + s[i].burnPointsPerHour!, 0)
          : null,
      drainPointsPerHour:
        p.drainPointsPerHour !== null
          ? seriesList.reduce((acc, s) => acc + s[i].drainPointsPerHour!, 0)
          : null,
    }));

  const makeAccount = (
    id: string,
    label: string,
    cap: number,
    remPct: number,
    resetAtMs: number
  ) => ({
    id,
    sourceAccountId: `fixture-source:${id}`,
    label,
    identifier: `${id}@example.test`,
    disabled: false,
    status: 'ok' as const,
    observedAtMs: NOW,
    remainingPercent: remPct,
    resetAtMs,
    burnPointsPerHour: 10,
    emptyAtMs: null,
    plan: { label: 'Max', capacityPoints: cap, known: true },
    windows: [],
    resets: null,
    billing: null,
  });

  const claudePool: QuotaPool = {
    provider: 'claude',
    instanceId: 'claude-primary',
    accountCount: 4,
    eligibleCount: 4,
    loadedCount: 4,
    capacityPoints: 8000,
    remainingPoints: 2160,
    burnPointsPerHour: 14,
    drainPointsPerHour: 14,
    forecastState: 'ready',
    firstEmptyAtMs: null,
    poolEmptyAtMs: null,
    nextResetAtMs: tReset1,
    nextResetGainPoints: 1840,
    recorded: claudeRec,
    projected: claudeProj,
    resets: [
      { atMs: tReset1, gainPoints: 1840 },
      { atMs: tEmpty, gainPoints: 1960 },
      { atMs: tClaude, gainPoints: 1960 },
    ],
    accounts: [makeAccount('claude-1', 'Claude 1', 8000, 27, tReset1)],
  };

  const codexPool: QuotaPool = {
    provider: 'codex',
    instanceId: 'codex-primary',
    accountCount: 1,
    eligibleCount: 1,
    loadedCount: 1,
    capacityPoints: 1000,
    remainingPoints: 640,
    burnPointsPerHour: 4,
    drainPointsPerHour: 4,
    forecastState: 'ready',
    firstEmptyAtMs: null,
    poolEmptyAtMs: null,
    nextResetAtMs: tReset1,
    nextResetGainPoints: 590,
    recorded: codexRec,
    projected: codexProj,
    resets: [
      { atMs: tReset1, gainPoints: 590 },
      { atMs: tCodex, gainPoints: 480 },
    ],
    accounts: [makeAccount('codex-1', 'Codex 1', 1000, 64, tReset1)],
  };

  const geminiPool: QuotaPool = {
    provider: 'antigravity',
    instanceId: 'gemini-primary',
    accountCount: 1,
    eligibleCount: 1,
    loadedCount: 1,
    capacityPoints: 2000,
    remainingPoints: 1581.1,
    burnPointsPerHour: 8,
    drainPointsPerHour: 8,
    forecastState: 'ready',
    firstEmptyAtMs: tEmpty,
    poolEmptyAtMs: tEmpty,
    nextResetAtMs: tGemini,
    nextResetGainPoints: 1940,
    recorded: geminiRec,
    projected: geminiProj,
    resets: [{ atMs: tGemini, gainPoints: 1940 }],
    accounts: [makeAccount('gemini-1', 'Gemini 1', 2000, 79.1, tGemini)],
  };

  const extraPools: QuotaPool[] = includeExtraProviders
    ? [
        {
          provider: 'kimi',
          displayName: 'Kimi',
          instanceId: 'kimi-primary',
          accountCount: 1,
          eligibleCount: 1,
          loadedCount: 1,
          capacityPoints: 3000,
          remainingPoints: 1890,
          burnPointsPerHour: 11,
          drainPointsPerHour: 11,
          forecastState: 'ready',
          firstEmptyAtMs: null,
          poolEmptyAtMs: null,
          nextResetAtMs: tGemini,
          nextResetGainPoints: 1200,
          recorded: recTimes.map((t, i) => pt(t, 2400 - i * 102, 11, 11)),
          projected: [
            pt(NOW, 1890),
            pt(tReset1, 1520),
            pt(tReset1, 1520),
            pt(tEmpty, 1210),
            pt(tEmpty, 1210),
            pt(tGemini, 760),
            pt(tGemini, 1960),
            pt(tClaude, 1880),
            pt(tClaude, 1880),
            pt(tCodex, 1610),
            pt(tCodex, 1610),
            pt(TO, 1420),
          ],
          resets: [{ atMs: tGemini, gainPoints: 1200 }],
          accounts: [makeAccount('kimi-1', 'Kimi 1', 3000, 63, tGemini)],
        },
        {
          provider: 'xai',
          displayName: 'Grok',
          instanceId: 'xai-primary',
          accountCount: 1,
          eligibleCount: 1,
          loadedCount: 1,
          capacityPoints: 1500,
          remainingPoints: 620,
          burnPointsPerHour: 9,
          drainPointsPerHour: 9,
          forecastState: 'ready',
          firstEmptyAtMs: null,
          poolEmptyAtMs: null,
          nextResetAtMs: tClaude,
          nextResetGainPoints: 900,
          recorded: recTimes.map((t, i) => pt(t, 1120 - i * 100, 9, 9)),
          projected: [
            pt(NOW, 620),
            pt(tReset1, 410),
            pt(tReset1, 410),
            pt(tEmpty, 280),
            pt(tEmpty, 280),
            pt(tGemini, 110),
            pt(tGemini, 110),
            pt(tClaude, 80),
            pt(tClaude, 980),
            pt(tCodex, 840),
            pt(tCodex, 840),
            pt(TO, 710),
          ],
          resets: [{ atMs: tClaude, gainPoints: 900 }],
          accounts: [makeAccount('xai-1', 'Grok 1', 1500, 41.3, tClaude)],
        },
        {
          provider: 'minimax',
          displayName: 'MiniMax',
          instanceId: 'minimax-primary',
          accountCount: 1,
          eligibleCount: 1,
          loadedCount: 1,
          capacityPoints: 4000,
          remainingPoints: 2680,
          burnPointsPerHour: 15,
          drainPointsPerHour: 15,
          forecastState: 'ready',
          firstEmptyAtMs: null,
          poolEmptyAtMs: null,
          nextResetAtMs: tCodex,
          nextResetGainPoints: 1600,
          recorded: recTimes.map((t, i) => pt(t, 3400 - i * 144, 15, 15)),
          projected: [
            pt(NOW, 2680),
            pt(tReset1, 2240),
            pt(tReset1, 2240),
            pt(tEmpty, 1910),
            pt(tEmpty, 1910),
            pt(tGemini, 1480),
            pt(tGemini, 1480),
            pt(tClaude, 1390),
            pt(tClaude, 1390),
            pt(tCodex, 1120),
            pt(tCodex, 2720),
            pt(TO, 2490),
          ],
          resets: [{ atMs: tCodex, gainPoints: 1600 }],
          accounts: [makeAccount('minimax-1', 'MiniMax 1', 4000, 67, tCodex)],
        },
      ]
    : [];

  const pools = [claudePool, codexPool, geminiPool, ...extraPools];
  const resetMap = new Map<number, number>();
  for (const p of pools) {
    for (const r of p.resets) resetMap.set(r.atMs, (resetMap.get(r.atMs) ?? 0) + r.gainPoints);
  }
  const totalSeries = {
    capacityPoints: pools.reduce((acc, p) => acc + p.capacityPoints, 0),
    remainingPoints: Number(pools.reduce((acc, p) => acc + p.remainingPoints!, 0).toFixed(1)),
    burnPointsPerHour: pools.reduce((acc, p) => acc + p.burnPointsPerHour!, 0),
    drainPointsPerHour: pools.reduce((acc, p) => acc + p.drainPointsPerHour!, 0),
    forecastState: 'ready' as const,
    recorded: sumSeries(pools.map((p) => p.recorded)),
    projected: sumSeries(pools.map((p) => p.projected)),
    resets: [...resetMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([atMs, gainPoints]) => ({ atMs, gainPoints })),
    poolEmptyAtMs: null,
  };

  const toLayer = (p: QuotaPool) => ({
    provider: p.provider,
    ...(p.displayName ? { displayName: p.displayName } : {}),
    instanceId: p.instanceId,
    capacityPoints: p.capacityPoints,
    remainingPoints: p.remainingPoints,
    burnPointsPerHour: p.burnPointsPerHour,
    drainPointsPerHour: p.drainPointsPerHour,
    forecastState: p.forecastState,
    recorded: p.recorded,
    projected: p.projected,
    resets: p.resets,
    poolEmptyAtMs: p.poolEmptyAtMs,
  });

  return {
    nowMs: NOW,
    fromMs: FROM,
    toMs: TO,
    window: 'weekly',
    lookbackHours: 3,
    multiplier: 1,
    historyStartedAtMs: FROM - 2 * DAY,
    lastRefreshAtMs: NOW,
    nextRefreshAtMs: NOW + 5 * 60_000,
    refreshing: false,
    issues: [],
    pools,
    combined: {
      all: {
        series: totalSeries,
        layers: pools.map(toLayer),
        unavailableReason: null,
      },
      ...Object.fromEntries(
        pools.map((p) => [
          p.provider,
          { series: toLayer(p), layers: [toLayer(p)], unavailableReason: null },
        ])
      ),
    },
  };
}

async function openQuota(page: Page, dashboard: PoolDashboard) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const reply = (json: unknown, status = 200) =>
      route.fulfill({ status, json, headers: { 'X-CPA-Version': 'v8.0.44' } });
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/prox/sources.json') return reply(discovery);
    const path = url.pathname.replace(/^\/v8\/management/, '');
    if (req.method() === 'GET') {
      if (path === '/config') return reply(config);
      if (path.startsWith('/prox/pools')) return reply(dashboard);
      if (path === '/prox/inventory')
        return reply({ version: 'a'.repeat(16), syncedAtMs: 0, sources: [] });
      if (path === '/auth-files' || path === '/credentials') return reply({ files: [] });
      if (path === '/config/access/api-keys') return reply(['synthetic-client-key']);
      if (path === '/usage') return reply({ usage: { total_requests: 0, apis: {} } });
      if (path === '/api-key-usage' || path === '/observability/usage/api-keys') return reply({});
      if (url.pathname === '/v1/models') return reply({ data: [] });
    }
    return route.continue();
  });
  await page.goto(`${origin}/#/quota`);
  await page.locator('input[type=password]').fill('synthetic-management-key');
  const rem = page.getByRole('checkbox', { name: 'Remember password' });
  if (await rem.isChecked()) await rem.uncheck();
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  const link = page.getByRole('link', { name: 'Quota Management', exact: true });
  await link.waitFor({ state: 'attached' });
  const menu = page.getByRole('button', { name: 'Expand sidebar', exact: true });
  if (await menu.isVisible()) await menu.click();
  await link.click();
  const close = page.getByRole('button', { name: 'Close', exact: true });
  if (await close.isVisible()) await close.click();
  const combined = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Combined usage', exact: true }),
  });
  await expect(combined.locator('svg[role="img"]')).toBeVisible();
  return combined;
}

async function saveEvidence(locator: ReturnType<Page['locator']>, name: string) {
  const dir = process.env.PROX_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await locator.screenshot({ path: join(dir, `${name}.png`) });
}

test('Combined usage renders normalized 0–100% Total + live capacity cards with multi-pin spotlight, scrubbing, and no overflow at 1440px and 390px', async ({
  page,
}) => {
  const dashboard = buildFixtureDashboard(false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const combined = await openQuota(page, dashboard);

  // Dropdown is gone; constant-height single plot renders Total + 3 quiet 0–100% curves + 3 live cards.
  await expect(combined.locator('select')).toHaveCount(0);
  await expect(combined.locator('svg [data-series="total"]')).toHaveCount(1);
  await expect(
    combined.locator('svg [data-series="claude-primary"][data-emphasis="quiet"]')
  ).toHaveCount(1);
  await expect(
    combined.locator('svg [data-series="codex-primary"][data-emphasis="quiet"]')
  ).toHaveCount(1);
  await expect(
    combined.locator('svg [data-series="gemini-primary"][data-emphasis="quiet"]')
  ).toHaveCount(1);
  await expect(combined.locator('[data-provider-card="claude-primary"]')).toBeVisible();
  await expect(combined.locator('[data-provider-card="codex-primary"]')).toBeVisible();
  await expect(combined.locator('[data-provider-card="gemini-primary"]')).toBeVisible();
  // Provider labels must render with visible non-zero width beside their shape glyphs.
  for (const key of ['claude-primary', 'codex-primary', 'gemini-primary']) {
    const labelBox = await combined
      .locator(`[data-provider-card="${key}"] [data-provider-label="true"]`)
      .boundingBox();
    expect(labelBox).not.toBeNull();
    expect(labelBox!.width).toBeGreaterThan(24);
  }
  await expect(combined.locator('svg [data-total-reset-tick="claude"]')).toHaveCount(3);
  await expect(combined.locator('svg [data-total-reset-tick="codex"]')).toHaveCount(2);
  await expect(combined.locator('svg [data-total-reset-tick="antigravity"]')).toHaveCount(1);
  await expect(combined.locator('svg [data-empty-marker="antigravity"]')).toHaveCount(1);
  await expect(combined).toContainText('100%');
  await expect(combined).toContainText('Total pts');
  await expect(combined).toContainText('Next reset: Claude +1,840, Codex +590');
  await saveEvidence(combined, 'combined-hybrid-3p-1440-rest');

  // Hovering a provider card previews it; clicking pins multiple providers head-to-head on 0–100%.
  await combined.locator('[data-provider-card="codex-primary"]').click();
  await combined.locator('[data-provider-card="gemini-primary"]').click();
  await expect(combined).toContainText('Comparing 2 pinned');
  await expect(
    combined.locator('svg [data-series="codex-primary"][data-emphasis="focused"]')
  ).toHaveCount(1);
  await expect(
    combined.locator('svg [data-series="gemini-primary"][data-emphasis="focused"]')
  ).toHaveCount(1);
  await expect(combined.locator('svg [data-total-reset-tick="claude"]')).toHaveCount(0);
  await expect(combined.locator('svg [data-total-reset-tick="codex"]')).toHaveCount(2);
  await saveEvidence(combined, 'combined-hybrid-3p-1440-pinned');
  await combined.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(combined.locator('svg [data-total-reset-tick="claude"]')).toHaveCount(3);

  // Keyboard Shift+ArrowRight hops directly to the first reset stop without shifting the SVG vertically.
  const svg = combined.locator('svg[role="img"]');
  const svgOffsetY = async () => {
    const [cardBox, chartBox] = await Promise.all([combined.boundingBox(), svg.boundingBox()]);
    expect(cardBox).not.toBeNull();
    expect(chartBox).not.toBeNull();
    return chartBox!.y - cardBox!.y;
  };
  const restOffset1440 = await svgOffsetY();
  await svg.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(combined).toContainText('Claude +1,840');
  await expect(combined).toContainText('Codex +590');
  await expect(combined.locator('[data-provider-card="claude-primary"]')).toContainText('+1,840');
  await expect(combined.locator('[data-provider-card="codex-primary"]')).toContainText('+590');
  await expect(combined.getByRole('button', { name: 'Now', exact: true })).toBeVisible();
  expect(Math.abs((await svgOffsetY()) - restOffset1440)).toBeLessThanOrEqual(1);
  await saveEvidence(combined, 'combined-hybrid-3p-1440-reset');

  // Escape returns cleanly to the latest reading.
  await page.keyboard.press('Escape');
  await expect(combined.getByRole('button', { name: 'Now', exact: true })).toHaveCount(0);

  // Mouse press captures the primary pointer so dragging past the SVG still scrubs and releases cleanly.
  const box1440 = await svg.boundingBox();
  expect(box1440).not.toBeNull();
  await page.mouse.move(box1440!.x + box1440!.width * 0.55, box1440!.y + box1440!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box1440!.x + box1440!.width + 40, box1440!.y + box1440!.height * 0.5);
  await page.mouse.up();
  await expect(combined.getByRole('button', { name: 'Now', exact: true })).toBeVisible();
  await combined.getByRole('button', { name: 'Now', exact: true }).click();
  await expect(combined.getByRole('button', { name: 'Now', exact: true })).toHaveCount(0);

  // Minimize collapses to the 160px Total plot keeping top-edge colored reset ticks & legend keys.
  await combined.getByRole('button', { name: /Minimize graph/ }).click();
  await expect(combined.locator('svg [data-series="total"]')).toHaveCount(1);
  await expect(combined.locator('[data-provider-card]')).toHaveCount(0);
  await expect(combined.locator('svg [data-total-reset-tick="codex"]')).toHaveCount(2);
  await expect(combined).toContainText('Scheduled reset:');
  await saveEvidence(combined, 'combined-hybrid-3p-1440-minimized');
  await combined.getByRole('button', { name: /Expand graph/ }).click();

  // Signed drain mode renders zero baseline in points/h and compact rate cards (no resets).
  await page.getByRole('button', { name: 'Drain rate', exact: true }).click();
  await expect(combined.locator('svg [data-total-reset-tick]')).toHaveCount(0);
  await expect(svg).toContainText('points/h');
  await expect(combined.locator('[data-provider-card="codex-primary"]')).toContainText('points/h');
  await saveEvidence(combined, 'combined-hybrid-3p-1440-drain');
  await page.getByRole('button', { name: 'Remaining', exact: true }).click();

  // Phone 390x844: touch-action: pan-y, zero horizontal overflow, vertical scroll never pins.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(svg).toHaveCSS('touch-action', 'pan-y');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(overflow).toBe(false);
  const restOffset390 = await svgOffsetY();
  await saveEvidence(combined, 'combined-hybrid-3p-390-rest');

  // Vertical touch swipe ending in pointercancel must leave the chart at rest (no accidental pin).
  await svg.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * 0.72;
    const y = r.top + r.height * 0.5;
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 11,
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        bubbles: true,
      })
    );
    el.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 11,
        pointerType: 'touch',
        clientX: x + 2,
        clientY: y + 42,
        bubbles: true,
      })
    );
    el.dispatchEvent(
      new PointerEvent('pointercancel', {
        pointerId: 11,
        pointerType: 'touch',
        clientX: x + 2,
        clientY: y + 42,
        bubbles: true,
      })
    );
  });
  await expect(combined.getByRole('button', { name: 'Now', exact: true })).toHaveCount(0);
  await expect(combined).toContainText('Next reset: Claude +1,840, Codex +590');

  // A clean touch tap (no vertical scroll) commits the pin, and Now clears it.
  await svg.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * 0.75;
    const y = r.top + r.height * 0.5;
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 12,
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        bubbles: true,
      })
    );
    el.dispatchEvent(
      new PointerEvent('pointerup', {
        pointerId: 12,
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        bubbles: true,
      })
    );
  });
  await expect(combined.getByRole('button', { name: 'Now', exact: true })).toBeVisible();
  await combined.getByRole('button', { name: 'Now', exact: true }).click();
  await expect(combined.getByRole('button', { name: 'Now', exact: true })).toHaveCount(0);

  // Native Chromium touch drag starting directly on a plotted child SVG path must survive
  // implicit child-to-SVG pointer capture transfer across multiple horizontal moves.
  const plottedPath = combined.locator('svg [data-series="total"] path').first();
  await plottedPath.scrollIntoViewIfNeeded();
  const pathBox = await plottedPath.boundingBox();
  const svgBox390 = await svg.boundingBox();
  expect(pathBox).not.toBeNull();
  expect(svgBox390).not.toBeNull();
  const startX = pathBox!.x + pathBox!.width * 0.5;
  const startY = pathBox!.y + pathBox!.height * 0.75;
  const hitTag = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.tagName.toLowerCase() ?? null,
    [startX, startY]
  );
  expect(hitTag).toBe('path');
  const cdp = await page.context().newCDPSession(page);
  const midX = svgBox390!.x + svgBox390!.width * 0.65;
  const endX = svgBox390!.x + svgBox390!.width * 0.92;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: startX, y: startY, id: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: midX, y: startY, id: 1 }],
  });
  await expect(combined).toContainText('Nov 30');
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: endX, y: startY, id: 1 }],
  });
  await expect(combined).toContainText('Dec 5');
  await expect(combined).toContainText('Codex +480');
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await cdp.detach();
  await expect(combined.getByRole('button', { name: 'Now', exact: true })).toBeVisible();
  await combined.getByRole('button', { name: 'Now', exact: true }).click();
  await expect(combined.getByRole('button', { name: 'Now', exact: true })).toHaveCount(0);

  await svg.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight'); // Claude solo reset at Dec 4
  await expect(combined.locator('[data-provider-card="claude-primary"]')).toContainText('+1,960');
  await expect(combined.locator('[data-provider-card="codex-primary"]')).toContainText(
    '613.7 / 1,000'
  );
  await expect(combined.locator('[data-provider-card="gemini-primary"]')).toContainText(
    '1,818.1 / 2,000'
  );
  expect(Math.abs((await svgOffsetY()) - restOffset390)).toBeLessThanOrEqual(1);
  await saveEvidence(combined, 'combined-hybrid-3p-390-reset');
  await combined.getByRole('button', { name: 'Now', exact: true }).click();
  await expect(combined.getByRole('button', { name: 'Now', exact: true })).toHaveCount(0);
});

test('Combined usage scales to 6 providers in constant plot height and persists Smart vs Ghost lines per browser', async ({
  page,
}) => {
  const dashboard = buildFixtureDashboard(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const combined = await openQuota(page, dashboard);

  // Default Smart mode with 6 providers renders the min–max spread band instead of 6 tangled lines.
  const smartBtn = combined.getByRole('button', { name: 'Smart', exact: true });
  const ghostBtn = combined.getByRole('button', { name: 'Ghost lines', exact: true });
  await expect(smartBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(ghostBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(combined.locator('svg [data-spread-band="true"]')).toHaveCount(1);
  await expect(combined.locator('svg [data-emphasis="quiet"]')).toHaveCount(0);
  await expect(combined.locator('[data-provider-card]')).toHaveCount(6);
  const svg = combined.locator('svg[role="img"]');
  await expect(svg).toHaveAttribute('viewBox', / 244$/);
  await saveEvidence(combined, 'combined-hybrid-6p-1440-smart');

  // Switching to Ghost lines persists in localStorage and survives a full page reload.
  await ghostBtn.click();
  await expect(ghostBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(combined.locator('svg [data-spread-band="true"]')).toHaveCount(0);
  await expect(combined.locator('svg [data-emphasis="quiet"]')).toHaveCount(6);
  const stored = await page.evaluate(() =>
    window.localStorage.getItem('quotaPool.combinedBackgroundMode')
  );
  expect(stored).toBe('ghost');
  await saveEvidence(combined, 'combined-hybrid-6p-1440-ghost');

  // Reload page and confirm Ghost lines preference is restored automatically.
  await page.reload();
  await page.locator('input[type=password]').fill('synthetic-management-key');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  const link = page.getByRole('link', { name: 'Quota Management', exact: true });
  await link.waitFor({ state: 'attached' });
  await link.click();
  await expect(combined.locator('svg[role="img"]')).toBeVisible();
  await expect(combined.getByRole('button', { name: 'Ghost lines', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(combined.locator('svg [data-emphasis="quiet"]')).toHaveCount(6);

  // Switch back to Smart, pin two providers, and verify clean 390px mobile layout with zero overflow.
  await combined.getByRole('button', { name: 'Smart', exact: true }).click();
  await expect(combined.locator('svg [data-spread-band="true"]')).toHaveCount(1);
  await combined.locator('[data-provider-card="codex-primary"]').click();
  await combined.locator('[data-provider-card="gemini-primary"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(svg).toHaveAttribute('viewBox', / 216$/);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(overflow).toBe(false);
  // Dismiss login toast if still visible so evidence screenshot stays unobstructed.
  const closeToast = page.locator('[role="status"] button, [role="alert"] button').first();
  if (await closeToast.isVisible().catch(() => false)) await closeToast.click();
  await saveEvidence(combined, 'combined-hybrid-6p-390-smart-pinned');
});
