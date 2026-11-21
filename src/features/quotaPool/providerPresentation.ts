import type { CSSProperties } from 'react';
import type { TFunction } from 'i18next';
import { isBuiltInPoolProvider } from '@/domain/quotaPool/providers';
import type { AccountQuotaWindow } from '@/domain/quotaPool/types';
import styles from './QuotaPoolPage.module.scss';

export function poolProviderLabel(t: TFunction, provider: string, displayName?: string): string {
  return isBuiltInPoolProvider(provider) || (provider === 'all' && !displayName)
    ? t(`quota_pool.${provider}`)
    : (displayName ?? provider);
}

export function poolProviderStyle(provider: string) {
  if (isBuiltInPoolProvider(provider)) return { className: styles[provider] };
  let hash = 0;
  for (const character of provider) hash = Math.imul(hash, 31) + character.charCodeAt(0);
  return { style: { '--pool-accent': `hsl(${(hash >>> 0) % 360} 58% 65%)` } as CSSProperties };
}

export function quotaWindowLabel(t: TFunction, window: AccountQuotaWindow): string {
  return window.label ?? t(window.labelKey, window.labelParams);
}
