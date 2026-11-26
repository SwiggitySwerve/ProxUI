import { expect, test } from './credentialFlowHarness';

test('a link from Analytics opens Auth Files on that one credential, by source and auth index', async ({
  flow,
  context,
}) => {
  const page = await flow.open(context, '/auth-files');
  await expect(page.getByText('carol', { exact: true }).first()).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = '/auth-files?source=claude-primary&auth_index=claude-dave';
  });
  // The page filters to that credential's source and file, then drops the link from the address.
  await expect(page.getByRole('textbox', { name: /^Search credentials/ })).toHaveValue('dave.json');
  await expect(page.getByText('dave', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('carol', { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/auth-files');
});
