/**
 * Antigravity 额度数据层：只保留状态形状，不发任何请求。
 * React-free / SCSS-free。
 */

import type { TFunction } from 'i18next';
import type {
  AntigravityQuotaGroup,
  AntigravityQuotaSubscription,
  AntigravityQuotaState,
  AuthFileItem,
} from '@/types';
import type { QuotaProviderData } from '../types';
import { isAntigravityQuotaFile } from '../filters';

export type AntigravityQuotaData = {
  groups: AntigravityQuotaGroup[];
  subscription: AntigravityQuotaSubscription | null;
  serverTimeOffsetMs: number | null;
};

/**
 * The Antigravity card never reads quota. Google suspended the account while a hub used its
 * Antigravity sign-in, and the terms bar third-party tools from it (docs/PROX-SETUP.md), so
 * nothing in ProxUI may send a request with that credential. The stored Gemini history stays on
 * Quota Management.
 */
export function createAntigravityQuotaConfig() {
  const fetchAntigravityQuota = async (
    _file: AuthFileItem,
    t: TFunction
  ): Promise<AntigravityQuotaData> => {
    throw new Error(t('antigravity_quota.not_read'));
  };

  const config: QuotaProviderData<AntigravityQuotaState, AntigravityQuotaData> = {
    type: 'antigravity',
    i18nPrefix: 'antigravity_quota',
    filterFn: isAntigravityQuotaFile,
    fetchQuota: fetchAntigravityQuota,
    storeSelector: (state) => state.antigravityQuota,
    storeSetter: 'setAntigravityQuota',
    buildLoadingState: () => ({
      status: 'loading',
      groups: [],
      subscription: null,
      serverTimeOffsetMs: null,
    }),
    buildSuccessState: (data) => ({
      status: 'success',
      groups: data.groups,
      subscription: data.subscription,
      serverTimeOffsetMs: data.serverTimeOffsetMs,
    }),
    buildErrorState: (message, status) => ({
      status: 'error',
      groups: [],
      subscription: null,
      serverTimeOffsetMs: null,
      error: message,
      errorStatus: status,
    }),
  };

  return config;
}
