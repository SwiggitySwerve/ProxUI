import type { BrowserContext, Page } from '@playwright/test';
import { expect, test, type CredentialFlow } from './credentialFlowHarness';

/** Logs in with "Remember password" checked so page.reload() restores the session in place. */
async function openRememberedAuthFiles(
  flow: CredentialFlow,
  context: BrowserContext
): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (error) => flow.errors.push(error.message));
  await page.goto('/');
  await page.locator('input[type=password]').fill('synthetic-management-key');
  await page.getByText('Remember password').click();
  await expect(page.getByLabel('Remember password')).toBeChecked();
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByRole('link', { name: 'Auth Files' }).first().waitFor({ state: 'attached' });
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 60_000 })
    .toBe('#/quota');
  await page.evaluate(() => {
    window.location.hash = '/auth-files';
  });
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 60_000 })
    .toBe('#/auth-files');
  return page;
}

test('a link from Analytics pins that one credential across reloads without polluting saved filters', async ({
  flow,
  context,
}) => {
  // A similar name must not join the view, and a remembered source/status filter must not hide it.
  await flow.addOutside('claude', 'backup-dave.json', 'backup@example.test');
  const page = await openRememberedAuthFiles(flow, context);
  await expect(page.getByText('carol', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: /^GPT \/ Codex/ }).click();
  await page
    .getByRole('button', { name: /^Disabled/ })
    .first()
    .click();
  await expect(page.getByText('carol', { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    window.location.hash = '/auth-files?source=claude-primary&auth_index=claude-dave';
  });
  // The page shows that credential's source and only it, then drops the link from the address.
  await expect(page.getByRole('textbox', { name: /^Search credentials/ })).toHaveValue('dave.json');
  await expect(page.getByText('dave', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('carol', { exact: true })).toHaveCount(0);
  await expect(page.getByText('backup-dave', { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/auth-files');
  // "Delete shown" only covers the pinned credential, even after a full page reload.
  await page.reload();
  await expect(page.getByRole('textbox', { name: /^Search credentials/ })).toHaveValue('dave.json');
  await expect(page.getByText('dave', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('backup-dave', { exact: true })).toHaveCount(0);
  const claudePanel = page.locator('[data-source-id="claude-primary"]');
  await claudePanel.getByRole('button', { name: /More actions/ }).click();
  await expect(page.getByRole('menuitem', { name: /Delete 1 shown/ })).toBeVisible();
  await page.keyboard.press('Escape');
  // Editing only Search while pinned clears the pin and updates only Search, keeping saved source/status.
  await page.getByRole('textbox', { name: /^Search credentials/ }).fill('alice');
  await expect(page.getByRole('textbox', { name: /^Search credentials/ })).toHaveValue('alice');
  await expect(page.getByRole('button', { name: /^GPT \/ Codex/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByRole('button', { name: /^Disabled/ }).first()).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  // Returning normally to Auth Files after another link keeps the user's saved filters untouched.
  await page.evaluate(() => {
    window.location.hash = '/auth-files?source=claude-primary&auth_index=claude-dave';
  });
  await expect(page.getByRole('textbox', { name: /^Search credentials/ })).toHaveValue('dave.json');
  await page.getByRole('link', { name: 'Quota Management' }).first().click();
  await page.getByRole('link', { name: 'Auth Files' }).first().click();
  await expect(page.getByRole('textbox', { name: /^Search credentials/ })).toHaveValue('alice');
  await expect(page.getByRole('button', { name: /^GPT \/ Codex/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByRole('button', { name: /^Disabled/ }).first()).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByText('dave', { exact: true })).toHaveCount(0);
});

test('a link to a deleted credential, blank auth_index, or removed source stays empty and disables deletes', async ({
  flow,
  context,
}) => {
  const page = await openRememberedAuthFiles(flow, context);
  await expect(page.getByText('carol', { exact: true }).first()).toBeVisible();
  const claudePanel = page.locator('[data-source-id="claude-primary"]');

  // Deleted credential or blank auth_index on an existing source: stays empty across reload until cleared.
  for (const link of [
    '/auth-files?source=claude-primary&auth_index=already-deleted',
    '/auth-files?source=claude-primary&auth_index=',
  ]) {
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, link);
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/auth-files');
    await expect(page.getByText('carol', { exact: true })).toHaveCount(0);
    await expect(page.getByText('dave', { exact: true })).toHaveCount(0);
    await expect(claudePanel.getByRole('button', { name: 'Clear filters' })).toBeVisible();
    await claudePanel.getByRole('button', { name: /More actions/ }).click();
    await expect(page.getByRole('menuitem', { name: /Delete 0 shown/ })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.getByText('carol', { exact: true })).toHaveCount(0);
    await expect(claudePanel.getByRole('button', { name: 'Clear filters' })).toBeVisible();
    await claudePanel.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByText('carol', { exact: true }).first()).toBeVisible();
  }

  // Removed or blank source: hides every other source immediately and offers Clear filters.
  for (const link of [
    '/auth-files?source=removed-hub&auth_index=claude-dave',
    '/auth-files?source=&auth_index=claude-dave',
  ]) {
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, link);
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/auth-files');
    await expect(page.getByText('carol', { exact: true })).toHaveCount(0);
    await expect(page.getByText('dave', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clear filters' }).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText('carol', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expect(page.getByText('carol', { exact: true }).first()).toBeVisible();
  }
});

test('reloading a pinned link without Remember password preserves the pin after signing back in', async ({
  flow,
  context,
}) => {
  await flow.addOutside('claude', 'backup-dave.json', 'backup@example.test');
  const page = await flow.open(context, '/auth-files');
  await expect(page.getByText('carol', { exact: true }).first()).toBeVisible();
  const claudePanel = page.locator('[data-source-id="claude-primary"]');

  // Blank auth_index survives reload -> /login -> sign-in without exposing deletes.
  await page.evaluate(() => {
    window.location.hash = '/auth-files?source=claude-primary&auth_index=';
  });
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/auth-files');
  await expect(claudePanel.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  await page.reload();
  await page.locator('input[type=password]').fill('synthetic-management-key');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/auth-files');
  await expect(page.getByText('carol', { exact: true })).toHaveCount(0);
  await expect(page.getByText('dave', { exact: true })).toHaveCount(0);
  await expect(claudePanel.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  await claudePanel.getByRole('button', { name: /More actions/ }).click();
  await expect(page.getByRole('menuitem', { name: /Delete 0 shown/ })).toBeDisabled();
  await page.keyboard.press('Escape');

  // A valid pin (even on case-variant /AUTH-FILES) also survives reload -> /login -> sign-in without expanding to backup-dave.
  await page.evaluate(() => {
    window.location.hash = '/AUTH-FILES?source=claude-primary&auth_index=claude-dave';
  });
  await expect(page.getByText('dave', { exact: true }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/AUTH-FILES');
  await page.reload();
  await page.locator('input[type=password]').fill('synthetic-management-key');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/AUTH-FILES');
  await expect(page.getByText('dave', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('backup-dave', { exact: true })).toHaveCount(0);
  await claudePanel.getByRole('button', { name: /More actions/ }).click();
  await expect(page.getByRole('menuitem', { name: /Delete 1 shown/ })).toBeVisible();
});
