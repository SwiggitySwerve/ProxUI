import { expect, test } from './analyticsHarness';

test.describe('in a New York browser', () => {
  test.use({ timezoneId: 'America/New_York' });

  test('Analytics asks for local time by default, labels it, and switches to UTC on request', async ({
    page,
    app,
  }) => {
    await app.login();
    await app.loaded();
    expect(app.queries.at(-1)).toMatchObject({ time_zone: 'America/New_York' });
    // The test clock is 29 October 2026, 12:00 UTC: 08:00 EDT.
    await expect(page.locator('header p').first()).toContainText('EDT');
    await expect(
      page.getByRole('heading', { name: 'Events by hour · EDT', exact: true })
    ).toBeVisible();
    await app.change(() => page.getByRole('button', { name: 'Use UTC', exact: true }).click());
    expect(app.queries.at(-1)).toMatchObject({ time_zone: 'UTC' });
    await expect(page.locator('header p').first()).toContainText('UTC');
    // The choice is the browser's: it comes back after a reload.
    await page.goto('about:blank');
    await app.login();
    await app.loaded();
    expect(app.queries.at(-1)).toMatchObject({ time_zone: 'UTC' });
    await app.change(() => page.getByRole('button', { name: /^Use local time/ }).click());
    expect(app.queries.at(-1)).toMatchObject({ time_zone: 'America/New_York' });
  });

  test('Today starts at local midnight, and the hour map can show the usual week', async ({
    page,
    app,
  }) => {
    await app.login();
    await app.loaded();
    await app.change(() => page.getByRole('button', { name: 'Today', exact: true }).click());
    // Midnight in New York on 29 October (EDT, UTC-4) is 04:00 UTC.
    expect(app.queries.at(-1)!.from_ms).toBe(Date.UTC(2026, 9, 29, 4));
    const map = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Events by hour · EDT', exact: true }),
    });
    await map.getByRole('button', { name: 'By weekday', exact: true }).click();
    await expect(map.getByRole('button', { name: 'By weekday', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(map.getByText('Mon', { exact: true }).first()).toBeVisible();
    // Weekday view shares the scale key and marks out-of-range days outside rather than 0 events.
    await expect(map).toContainText('not measured');
    await map.getByText('View data table', { exact: true }).click();
    const monRow = map.locator('tbody tr', { hasText: 'Mon' });
    await expect(monRow.locator('td').first()).toHaveText('');
  });
});

test('the Performance tab shows each account’s peak requests in flight, source, and peak time', async ({
  page,
  app,
}) => {
  await app.login();
  await app.loaded();
  await app.tab('Performance');
  const chart = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Peak requests in flight, by account', exact: true }),
  });
  await expect(chart).toContainText('started in this range');
  const row = chart.getByRole('listitem').filter({ hasText: 'ada•••ce@ex•••.test' });
  await expect(row).toContainText('claude-primary');
  await expect(row).toContainText('Oct 29, 07:00 UTC');
  await expect(row).toContainText('6');
});

test.describe('in Lord Howe across part-hour transitions', () => {
  test.use({ timezoneId: 'Australia/Lord_Howe' });

  test('UTC Yesterday does not offer a broken Use local button when local Yesterday crosses +10:30', async ({
    page,
    app,
  }) => {
    await page.clock.setFixedTime(new Date('2026-04-05T14:00:00Z'));
    await page.addInitScript(() => {
      localStorage.setItem(
        'proxui-display-zone',
        JSON.stringify({ state: { utc: true }, version: 0 })
      );
    });
    await app.login();
    await app.loaded();
    await app.change(() => page.getByRole('button', { name: 'Yesterday', exact: true }).click());
    expect(app.queries.at(-1)).toMatchObject({ time_zone: 'UTC' });
    await expect(page.getByRole('button', { name: /^Use local time/ })).toHaveCount(0);
  });

  test('UTC 1h in +11:00 offers Use local time and switches into Australia/Lord_Howe', async ({
    page,
    app,
  }) => {
    await page.clock.setFixedTime(new Date('2026-10-05T12:00:00Z'));
    await page.addInitScript(() => {
      localStorage.setItem(
        'proxui-display-zone',
        JSON.stringify({ state: { utc: true }, version: 0 })
      );
    });
    await app.login();
    await app.loaded();
    await app.change(() => page.getByRole('button', { name: 'Last hour', exact: true }).click());
    expect(app.queries.at(-1)).toMatchObject({ time_zone: 'UTC' });
    await app.change(() => page.getByRole('button', { name: /^Use local time/ }).click());
    expect(app.queries.at(-1)).toMatchObject({ time_zone: 'Australia/Lord_Howe' });
  });

  test('Tokens provider stack labels a clipped first bucket in GMT+11 for axis, hover, and table', async ({
    page,
    app,
  }) => {
    // 2026-10-04 15:45Z -> 24h window [Oct 3 15:45Z, Oct 4 15:45Z] is wholly GMT+11,
    // while UTC bucket 15:00Z started before the 15:30Z jump (01:30 GMT+10:30).
    await page.clock.setFixedTime(new Date('2026-10-04T15:45:00Z'));
    await app.login();
    await app.loaded();
    expect(app.queries.at(-1)).toMatchObject({ time_zone: 'Australia/Lord_Howe' });
    await app.tab('Tokens & Cache');
    const stack = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Tokens by provider', exact: true }),
    });
    const clippedBucket = String(Date.UTC(2026, 9, 3, 15, 0));
    const firstBar = stack.locator(`[data-at="${clippedBucket}"]`);
    await expect(firstBar).toBeVisible();
    await expect(stack).not.toContainText('01:30');
    await firstBar.hover();
    await expect(stack.locator('output')).toContainText('Oct 4, 02:45 GMT+11');
    await expect(stack.locator('output')).not.toContainText('GMT+10:30');
    await stack.getByText('View data table', { exact: true }).click();
    await expect(stack.locator('tbody th').first()).toContainText('Oct 4, 02:45 GMT+11');
  });
});
