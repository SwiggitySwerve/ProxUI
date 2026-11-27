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

function buildFixtureDashboard(): PoolDashboard {
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

  const sumPoints = (a: PoolPoint[], b: PoolPoint[], c: PoolPoint[]) =>
    a.map((p, i) => ({
      atMs: p.atMs,
      remainingPoints: Number(
        (p.remainingPoints! + b[i].remainingPoints! + c[i].remainingPoints!).toFixed(1)
      ),
      burnPointsPerHour:
        p.burnPointsPerHour !== null
          ? p.burnPointsPerHour + b[i].burnPointsPerHour! + c[i].burnPointsPerHour!
          : null,
      drainPointsPerHour:
        p.drainPointsPerHour !== null
          ? p.drainPointsPerHour + b[i].drainPointsPerHour! + c[i].drainPointsPerHour!
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

  const totalSeries = {
    capacityPoints: 11000,
    remainingPoints: 4381.1,
    burnPointsPerHour: 26,
    drainPointsPerHour: 26,
    forecastState: 'ready' as const,
    recorded: sumPoints(claudeRec, codexRec, geminiRec),
    projected: sumPoints(claudeProj, codexProj, geminiProj),
    resets: [
      { atMs: tReset1, gainPoints: 2430 },
      { atMs: tEmpty, gainPoints: 1960 },
      { atMs: tGemini, gainPoints: 1940 },
      { atMs: tClaude, gainPoints: 1960 },
      { atMs: tCodex, gainPoints: 480 },
    ],
    poolEmptyAtMs: null,
  };

  const toLayer = (p: QuotaPool) => ({
    provider: p.provider,
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
    pools: [claudePool, codexPool, geminiPool],
    combined: {
      all: {
        series: totalSeries,
        layers: [toLayer(claudePool), toLayer(codexPool), toLayer(geminiPool)],
        unavailableReason: null,
      },
      claude: {
        series: toLayer(claudePool),
        layers: [toLayer(claudePool)],
        unavailableReason: null,
      },
      codex: { series: toLayer(codexPool), layers: [toLayer(codexPool)], unavailableReason: null },
      antigravity: {
        series: toLayer(geminiPool),
        layers: [toLayer(geminiPool)],
        unavailableReason: null,
      },
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

test('Combined usage renders Total + own-scale provider lanes with reset attribution, keyboard stepping, and no overflow at 1440px and 390px', async ({
  page,
}) => {
  const dashboard = buildFixtureDashboard();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const combined = await openQuota(page, dashboard);

  // Dropdown is gone; Total + 3 own-scale provider lanes render cleanly.
  await expect(combined.locator('select')).toHaveCount(0);
  await expect(combined.locator('svg [data-series="total"]')).toHaveCount(1);
  await expect(combined.locator('svg [data-series="claude-primary"]')).toHaveCount(1);
  await expect(combined.locator('svg [data-series="codex-primary"]')).toHaveCount(1);
  await expect(combined.locator('svg [data-series="gemini-primary"]')).toHaveCount(1);
  await expect(combined.locator('svg [data-reset-provider="claude"]')).toHaveCount(3);
  await expect(combined.locator('svg [data-reset-provider="codex"]')).toHaveCount(2);
  await expect(combined.locator('svg [data-reset-provider="antigravity"]')).toHaveCount(1);
  await expect(combined.locator('svg [data-empty-marker="antigravity"]')).toHaveCount(1);
  await expect(combined).toContainText('Next reset: Claude +1,840, Codex +590');
  await saveEvidence(combined, 'combined-lanes-1440-rest');

  // Keyboard Shift+ArrowRight hops directly to the first reset stop (simultaneous Claude + Codex),
  // showing Total, both reset pills, and before -> after gains in each lane caption without shifting the SVG.
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
  await expect(combined).toContainText('1,510 → 3,350 (+1,840)');
  await expect(combined).toContainText('160 → 750 (+590)');
  await expect(combined.getByRole('button', { name: 'Now', exact: true })).toBeVisible();
  expect(Math.abs((await svgOffsetY()) - restOffset1440)).toBeLessThanOrEqual(1);
  await saveEvidence(combined, 'combined-lanes-1440-reset');

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
  await expect(combined.locator('svg [data-series="claude-primary"]')).toHaveCount(0);
  await expect(combined.locator('svg [data-total-reset-tick="codex"]')).toHaveCount(2);
  await expect(combined).toContainText('Scheduled reset:');
  await saveEvidence(combined, 'combined-lanes-1440-minimized');
  await combined.getByRole('button', { name: /Expand graph/ }).click();

  // Signed drain mode renders zero baseline (never hiding 0 in Codex's compact lane) and omits resets.
  await page.getByRole('button', { name: 'Drain rate', exact: true }).click();
  await expect(combined.locator('svg [data-reset-provider]')).toHaveCount(0);
  await expect(svg).toContainText('points/h');
  const codexDrainChrome = combined.locator('svg [data-lane-header="codex-primary"]');
  await expect(codexDrainChrome).toContainText('0');
  await expect(codexDrainChrome).toContainText('-20');
  await saveEvidence(combined, 'combined-lanes-1440-drain');
  await page.getByRole('button', { name: 'Remaining', exact: true }).click();

  // Phone 390x844: touch-action: pan-y, zero horizontal overflow, vertical scroll never pins.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(svg).toHaveCSS('touch-action', 'pan-y');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(overflow).toBe(false);
  const restOffset390 = await svgOffsetY();
  await saveEvidence(combined, 'combined-lanes-390-rest');

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
  await expect(combined).toContainText('7,852.5 (+1,960)');
  await expect(combined).toContainText('613.7 / 1,000');
  await expect(combined).toContainText('1,818.1 / 2,000');
  // Plot does not jump vertically when the readout enters inspection state on mobile.
  expect(Math.abs((await svgOffsetY()) - restOffset390)).toBeLessThanOrEqual(1);
  // Active crosshair hides colliding Codex +480 text so the dot never overlaps digits.
  await expect(
    combined.locator('svg [data-series="codex-primary"] text', { hasText: '+480' })
  ).toHaveCount(0);
  await saveEvidence(combined, 'combined-lanes-390-reset');
  await combined.getByRole('button', { name: 'Now', exact: true }).click();
  await expect(combined.getByRole('button', { name: 'Now', exact: true })).toHaveCount(0);
  await expect(
    combined.locator('svg [data-series="codex-primary"] text', { hasText: '+480' })
  ).toHaveCount(1);
});
