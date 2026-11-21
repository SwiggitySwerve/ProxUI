import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type {
  AccountQuotaWindow,
  PoolDashboard,
  PoolProfileUpdate,
  PoolWindow,
  UnpooledProvider,
} from '@/domain/quotaPool/types';
import { canPoolWindow, preferredPoolWindow } from '@/domain/quotaWindows/normalized';
import { PoolProviderMark } from './PoolProviderMark';
import { formatPoolPercent } from './presentation';
import { quotaWindowLabel } from './providerPresentation';
import styles from './QuotaPoolPage.module.scss';

type SaveProfile = (profile: PoolProfileUpdate) => Promise<boolean>;

export function DiscoveredQuota({
  dashboard,
  saveProfile,
}: {
  dashboard: Pick<PoolDashboard, 'awaitingAuth' | 'unpooled'>;
  saveProfile: SaveProfile;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  return (
    <>
      {!!dashboard.awaitingAuth?.length && (
        <section className={styles.discovered} aria-labelledby={`${id}-awaiting`}>
          <h2 id={`${id}-awaiting`}>{t('provider_catalog.awaiting_auth_section_title')}</h2>
          {dashboard.awaitingAuth.map(({ instanceId, provider, displayName, sourceLabel }) => (
            <div className={styles.discoveredCard} key={`${instanceId}:${provider}`}>
              <div className={styles.discoveredHeading}>
                <PoolProviderMark provider={provider} />
                <h3>
                  {displayName} <small>· {sourceLabel}</small>
                </h3>
                <Link className={styles.accountLink} to="/oauth">
                  {t('provider_catalog.connect_action')} <span aria-hidden="true">→</span>
                </Link>
              </div>
            </div>
          ))}
        </section>
      )}
      {!!dashboard.unpooled?.length && (
        <section className={styles.discovered} aria-labelledby={`${id}-unpooled`}>
          <h2 id={`${id}-unpooled`}>{t('provider_catalog.unpooled_section_title')}</h2>
          {dashboard.unpooled.map((entry) => (
            <div className={styles.discoveredCard} key={`${entry.instanceId}:${entry.provider}`}>
              <div className={styles.discoveredHeading}>
                <PoolProviderMark provider={entry.provider} />
                <h3>
                  {entry.displayName} <small>· {entry.sourceLabel}</small>
                </h3>
              </div>
              <ul className={styles.discoveredAccounts}>
                {entry.accounts.map((account) => (
                  <li key={account.id}>
                    <p>
                      <strong>{account.identifier || account.label}</strong>
                      {account.planLabel && <span> · {account.planLabel}</span>}
                      <span>
                        {' '}
                        ·{' '}
                        {account.status === 'no-reader'
                          ? t('provider_catalog.no_quota_reader')
                          : t(`quota_pool.account_status.${account.status}`)}
                      </span>
                    </p>
                    {!!account.windows.length && (
                      <dl>
                        {account.windows.map((window) => (
                          <div key={window.id}>
                            <dt>{quotaWindowLabel(t, window)}</dt>
                            <dd>
                              {window.remainingPercent === null
                                ? t('quota_pool.account_status.missing-window')
                                : formatPoolPercent(window.remainingPercent, i18n.language)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </li>
                ))}
              </ul>
              <PoolProfileForm entry={entry} saveProfile={saveProfile} />
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function PoolProfileForm({
  entry,
  saveProfile,
}: {
  entry: UnpooledProvider;
  saveProfile: SaveProfile;
}) {
  const { t } = useTranslation();
  // A provider advertises the same bucket on each account; show it once in the picker.
  const byId = new Map<string, AccountQuotaWindow>();
  const plans = new Map<string, string>();
  for (const account of entry.accounts) {
    for (const window of account.windows) {
      const previous = byId.get(window.id);
      if (!previous || previous.periodHours == null) byId.set(window.id, window);
    }
    // Only a plan the provider names can be weighted (server/quota/plans.ts).
    if (account.planType) plans.set(account.planType, account.planLabel ?? account.planType);
  }
  const windows = [...byId.values()];
  const [weekly, setWeekly] = useState<string | null>(null);
  const [fiveHour, setFiveHour] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const eligible = (lane: PoolWindow) => windows.filter((window) => canPoolWindow(window, lane));
  if (!eligible('weekly').length && !eligible('five-hour').length) return null;
  const selected = (lane: PoolWindow, id: string | null) =>
    id === null
      ? (preferredPoolWindow(windows, lane)?.id ?? '')
      : (eligible(lane).find((entry) => entry.id === id)?.id ?? '');
  const weeklyId = selected('weekly', weekly);
  const fiveHourId = selected('five-hour', fiveHour);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || (!weeklyId && !fiveHourId)) return;
    const data = new FormData(event.currentTarget);
    const planUnits = Object.fromEntries(
      [...plans.keys()].flatMap((id) => {
        const value = data.get(`units:${id}`);
        return value ? [[id, Number(value)]] : [];
      })
    );
    setSaving(true);
    setFailed(false);
    const saved = await saveProfile({
      instanceId: entry.instanceId,
      provider: entry.provider,
      weeklyWindowId: weeklyId || null,
      fiveHourWindowId: fiveHourId || null,
      planUnits,
      enabled: true,
    });
    setSaving(false);
    setFailed(!saved);
  };
  const picker = (lane: PoolWindow, value: string, other: string, select: (id: string) => void) => (
    <label>
      {t(
        lane === 'weekly'
          ? 'provider_catalog.pool_profile_weekly'
          : 'provider_catalog.pool_profile_five_hour'
      )}
      <select value={value} onChange={(event) => select(event.target.value)} disabled={saving}>
        <option value="">{t('provider_catalog.pool_profile_none')}</option>
        {eligible(lane).map((window) => (
          <option key={window.id} value={window.id} disabled={window.id === other}>
            {quotaWindowLabel(t, window)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <details className={styles.profileDetails}>
      <summary>{t('provider_catalog.opt_in_pool')}</summary>
      <form className={styles.profileForm} onSubmit={(event) => void submit(event)}>
        {picker('weekly', weeklyId, fiveHourId, setWeekly)}
        {picker('five-hour', fiveHourId, weeklyId, setFiveHour)}
        {[...plans].map(([id, label]) => (
          <label key={id}>
            {t('provider_catalog.pool_profile_units')}
            {plans.size > 1 && ` · ${label}`}
            <input
              name={`units:${id}`}
              type="number"
              min="0"
              step="any"
              placeholder="1"
              disabled={saving}
            />
          </label>
        ))}
        <button type="submit" disabled={saving || (!weeklyId && !fiveHourId)}>
          {t('provider_catalog.pool_profile_save')}
        </button>
        {failed && (
          <p role="alert">
            {t('common.error')} · {t('provider_catalog.pool_profile_title')}
          </p>
        )}
      </form>
    </details>
  );
}
