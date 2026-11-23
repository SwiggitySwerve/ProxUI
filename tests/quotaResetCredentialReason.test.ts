import { describe, expect, test } from 'bun:test';
import { credentialLookupReason } from '../src/features/quotaPool/model/credentialReason';

describe('why a reset has no credential to use', () => {
  test('a finished lookup with no active match asks for a sign-in', () => {
    expect(credentialLookupReason(true, 'ready')).toBe('quota_pool.reset_lookup_failed');
  });
  test('a failed read asks for a retry, not a sign-in', () => {
    expect(credentialLookupReason(false, 'error')).toBe('quota_pool.reset_credentials_unreadable');
  });
  test('a lookup still running says so', () => {
    expect(credentialLookupReason(false, 'loading')).toBe('quota_pool.reset_checking_credential');
    expect(credentialLookupReason(false, 'idle')).toBe('quota_pool.reset_checking_credential');
  });
});
