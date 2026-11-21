import type { PoolProviderId } from '@/domain/quotaPool/types';
import { PROVIDER_LOGOS } from '@/features/providers/brandLogos';
import { isBuiltInPoolProvider } from '@/domain/quotaPool/providers';
import { poolProviderStyle } from './providerPresentation';
import styles from './QuotaPoolPage.module.scss';

export function PoolProviderMark({ provider }: { provider: PoolProviderId }) {
  if (!isBuiltInPoolProvider(provider)) {
    return (
      <span
        className={`${styles.providerMark} ${styles.providerMonogram}`}
        aria-hidden="true"
        style={poolProviderStyle(provider).style}
      >
        {provider.charAt(0).toUpperCase()}
      </span>
    );
  }
  // The Antigravity pool is named Gemini, so it carries the Gemini mark.
  const logo = PROVIDER_LOGOS[provider === 'antigravity' ? 'gemini' : provider];
  return <img className={styles.providerMark} src={logo.src} alt="" />;
}
