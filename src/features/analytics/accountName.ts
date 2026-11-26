import type { TFunction } from 'i18next';
import type { AnalyticsAccount } from '@/domain/analytics/types';
import { maskIdentifier } from '@/domain/quotaPool/mask';

/** How Analytics names a credential: its label (masked until "Show emails"), else its index. */
export function accountName(
  account: Pick<AnalyticsAccount, 'label' | 'auth_index'>,
  reveal: boolean,
  t: TFunction
): string {
  if (account.label) return reveal ? account.label : maskIdentifier(account.label);
  return account.auth_index
    ? t('analytics.routing.credential', { index: account.auth_index })
    : t('analytics.routing.unattributed');
}
