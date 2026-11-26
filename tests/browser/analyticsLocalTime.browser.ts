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
  });
});

test('the Performance tab shows each account’s peak requests in flight', async ({ page, app }) => {
  await app.login();
  await app.loaded();
  await app.tab('Performance');
  const chart = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Peak requests in flight, by account', exact: true }),
  });
  await expect(
    chart.getByRole('listitem').filter({ hasText: 'ada•••ce@ex•••.test' })
  ).toContainText('6');
});
