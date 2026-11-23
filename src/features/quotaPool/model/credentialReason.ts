/** A finished lookup with no active match needs a sign-in; a failed read only needs a retry. */
export function credentialLookupReason(
  listed: boolean,
  status: 'idle' | 'loading' | 'ready' | 'error'
) {
  if (listed) return 'quota_pool.reset_lookup_failed';
  return status === 'error'
    ? 'quota_pool.reset_credentials_unreadable'
    : 'quota_pool.reset_checking_credential';
}
