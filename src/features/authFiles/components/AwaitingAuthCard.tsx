import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconUpload } from '@/components/ui/icons';
import styles from './AwaitingAuthCard.module.scss';

export interface AwaitingAuthCardProps {
  label: string;
  /** Null renders the label's initial instead. */
  iconSrc: string | null;
  compact: boolean;
  /** Null when the provider has no OAuth flow: only an upload can activate it. */
  onSignIn: (() => void) | null;
  onUpload: () => void;
  disabled: boolean;
}

/**
 * A provider the hub advertises with no credential yet. Signing in or uploading a credential
 * activates it; the live credential card then replaces this one.
 */
export function AwaitingAuthCard({
  label,
  iconSrc,
  compact,
  onSignIn,
  onUpload,
  disabled,
}: AwaitingAuthCardProps) {
  const { t } = useTranslation();
  return (
    <article
      className={`${styles.card} ${compact ? styles.compact : ''}`}
      aria-label={`${label} · ${t('provider_catalog.awaiting_auth')}`}
      data-lifecycle="awaiting_auth"
    >
      <div className={styles.head}>
        {iconSrc ? (
          <img src={iconSrc} alt="" className={styles.icon} />
        ) : (
          <span className={styles.iconFallback} aria-hidden="true">
            {label.slice(0, 1).toUpperCase()}
          </span>
        )}
        <h4 className={styles.name} title={label}>
          {label}
        </h4>
        <span className={styles.badge}>{t('provider_catalog.awaiting_auth')}</span>
      </div>
      {!compact && <p className={styles.desc}>{t('provider_catalog.awaiting_auth_desc')}</p>}
      <div className={styles.actions}>
        {onSignIn && (
          <Button size="sm" onClick={onSignIn} disabled={disabled}>
            {t('provider_catalog.connect_action')}
          </Button>
        )}
        <Button
          variant={onSignIn ? 'ghost' : 'primary'}
          size="sm"
          onClick={onUpload}
          disabled={disabled}
        >
          <IconUpload size={14} aria-hidden="true" /> {t('provider_catalog.upload_action')}
        </Button>
      </div>
    </article>
  );
}
