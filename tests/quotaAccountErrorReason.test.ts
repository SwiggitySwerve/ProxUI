import { describe, expect, test } from 'bun:test';
import { buildAccounts } from '../server/quota/accounts';
import type { StoredAccount } from '../server/quota/types';

const NOW = 1_800_000_000_000;
const account = (overrides: Partial<StoredAccount> = {}): StoredAccount => ({
  id: 'claude-primary:claude:synthetic',
  instanceId: 'claude-primary',
  sourceAccountId: 'claude-primary:claude:synthetic',
  provider: 'claude',
  name: 'synthetic.json',
  email: 'synthetic@example.test',
  disabled: false,
  retired: false,
  lastSeenAtMs: NOW,
  lastErrorAtMs: NOW,
  ...overrides,
});
const served = (stored: StoredAccount) =>
  buildAccounts({
    accounts: [stored],
    latestSamples: [],
    windows: new Map(),
    resets: new Map(),
    billing: new Map(),
    balances: new Map(),
    nowMs: NOW,
    reveal: false,
    collection: { lastRefreshAtMs: NOW, nextRefreshAtMs: NOW, refreshing: false },
  }).accounts[0];

describe('/v1/accounts says why a read failed', () => {
  test('an account whose hub said its sign-in expired carries that reason', () => {
    const body = served(account({ lastErrorReason: 'signin-expired' }));
    expect(body.status).toBe('error');
    expect(body.errorReason).toBe('signin-expired');
  });
  test('a failure without a known cause, or no failure, carries none', () => {
    expect(served(account())).not.toHaveProperty('errorReason');
    expect(
      served(account({ lastErrorAtMs: null, lastErrorReason: 'signin-expired' }))
    ).not.toHaveProperty('errorReason');
  });
});
