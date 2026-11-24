import { authFileStatusWarning } from '@/features/authFiles/constants';
import type { PoolAccount, PoolProviderId } from '@/domain/quotaPool/types';
import type { AuthFileItem } from '@/types';
import { findPoolResetFile } from '../resetAccounts';

/**
 * True when the server could not read this account and the hub says why: the provider no longer
 * accepts its refresh token. Nothing but signing in again brings it back.
 */
export function signInExpired(
  files: readonly AuthFileItem[] | undefined,
  instanceId: string | undefined,
  provider: PoolProviderId,
  account: Pick<PoolAccount, 'status' | 'sourceAccountId'>
): boolean {
  if (account.status !== 'error' || !files || !instanceId) return false;
  const file = findPoolResetFile(files, instanceId, provider, account.sourceAccountId);
  return !!file && authFileStatusWarning(file, 0)?.kind === 'signin_expired';
}
