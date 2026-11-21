import type { PoolDashboard, PoolProfileUpdate } from '../../src/domain/quotaPool/types';
import { expect, test } from './credentialFlowHarness';

test('Quota Management shows discoveries and saves a provider-specific pool profile', async ({
  context,
  flow,
}) => {
  const identity = {
    instanceId: 'orbit-hub',
    sourceLabel: 'Orbit hub',
    provider: 'orbit-ai',
    displayName: 'Orbit AI',
  };
  let stage: 'waiting' | 'unpooled' | 'pooled' = 'waiting';
  let savedProfile: PoolProfileUpdate | undefined;
  await context.route('**/gemini/v8/management/credentials', (route) =>
    route.fulfill({ json: { files: [] } })
  );
  await context.route('**/gemini/v8/management/config', (route) => route.fulfill({ json: {} }));
  await context.route('**/v8/management/prox/pools*', async (route) => {
    const query = new URL(route.request().url()).search;
    const baseline = await flow.history<PoolDashboard>(`/v1/pools${query}`);
    const windows = [
      {
        id: 'orbit-week',
        label: 'Account weekly',
        labelKey: 'quota_pool.remaining',
        remainingPercent: 60,
        resetAtMs: null,
        periodHours: 168,
        scope: 'account' as const,
      },
      {
        id: 'orbit-five',
        label: 'Account session',
        labelKey: 'quota_pool.remaining',
        remainingPercent: 72,
        resetAtMs: null,
        periodHours: 5,
        scope: 'account' as const,
      },
      {
        id: 'orbit-model',
        label: 'Model weekly',
        labelKey: 'quota_pool.remaining',
        remainingPercent: 94,
        resetAtMs: null,
        periodHours: 168,
        scope: 'model' as const,
      },
    ];
    const accounts = [
      {
        id: 'orbit-account',
        identifier: 'o•••@example.test',
        label: 'Orbit AI 1',
        status: 'ok' as const,
        observedAtMs: baseline.nowMs,
        planLabel: 'Team',
        planType: 'team',
        windows,
      },
    ];
    const builtIn = baseline.pools.find((pool) => pool.provider === 'codex')!;
    const pool = {
      ...builtIn,
      ...identity,
      accountCount: 1,
      eligibleCount: 1,
      loadedCount: 1,
      capacityPoints: 250,
      remainingPoints: 150,
      accounts: [
        {
          ...builtIn.accounts[0],
          ...accounts[0],
          resets: null,
          billing: null,
          plan: { label: 'Team', capacityPoints: 250, known: true },
        },
      ],
    };
    await route.fulfill({
      json: {
        ...baseline,
        awaitingAuth: stage === 'waiting' ? [{ ...identity, quotaSupported: true }] : [],
        unpooled: stage === 'unpooled' ? [{ ...identity, accounts }] : [],
        ...(stage === 'pooled' && {
          pools: [...baseline.pools, pool],
          poolProfiles: [{ ...savedProfile, updatedAtMs: baseline.nowMs }],
          combined: { ...baseline.combined, 'orbit-ai': { series: pool, unavailableReason: null } },
        }),
      },
    });
  });
  await context.route('**/v8/management/prox/pool-profiles', async (route) => {
    expect(route.request().method()).toBe('PUT');
    savedProfile = route.request().postDataJSON() as PoolProfileUpdate;
    stage = 'pooled';
    await route.fulfill({ json: { profile: { ...savedProfile, updatedAtMs: Date.now() } } });
  });

  const page = await flow.open(context, '/quota');
  const waiting = page.getByRole('region', { name: 'Waiting for auth' });
  await expect(waiting).toContainText('Orbit hub');
  await expect(waiting.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '#/oauth');

  stage = 'unpooled';
  await page.getByRole('button', { name: 'Refresh All' }).click();
  const unpooled = page.getByRole('region', { name: 'Discovered providers (not pooled)' });
  await expect(unpooled).toContainText('60.0%');
  await expect(unpooled).toContainText('Model weekly');
  await unpooled.getByText('Add to quota pool').click();
  await expect(unpooled.getByLabel('Weekly window')).toHaveValue('orbit-week');
  await expect(unpooled.getByLabel('5-hour window')).toHaveValue('orbit-five');
  await expect(unpooled.getByRole('option', { name: 'Model weekly' })).toHaveCount(0);
  await unpooled.getByLabel('5-hour window').selectOption('');
  await unpooled.getByLabel('Base-plan units (1 unit = 100 pts)').fill('2.5');
  await unpooled.getByRole('button', { name: 'Save pool settings' }).click();

  await expect(unpooled).toHaveCount(0);
  expect(savedProfile).toEqual({
    instanceId: 'orbit-hub',
    provider: 'orbit-ai',
    weeklyWindowId: 'orbit-week',
    fiveHourWindowId: null,
    planUnits: { team: 2.5 },
    enabled: true,
  });
  const chip = page.getByRole('button', { name: 'Orbit AI 1' });
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/provider=orbit-ai/);
  await expect(page.getByRole('article', { name: /Orbit AI/ })).toContainText('150');
});
