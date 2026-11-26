import { useId } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconEye } from '@/components/ui/icons';
import type { AnalyticsAccount, AnalyticsResponse } from '@/domain/analytics/types';
import { providerInk } from '@/features/providers/identity';
import { accountName } from './accountName';
import { heatLevel } from './chartGeometry';
import { analyticsCompact, analyticsNumber } from './format';
import styles from './AnalyticsPage.module.scss';

const accountKey = (a: { instance: string | null; auth_index: string | null }) =>
  JSON.stringify([a.instance, a.auth_index]);

/** Auth Files opens on this credential: its source and the proxy's auth index, never its label. */
const authFilesLink = (account: Pick<AnalyticsAccount, 'instance' | 'auth_index'>) =>
  account.instance && account.auth_index
    ? `/auth-files?${new URLSearchParams({ source: account.instance, auth_index: account.auth_index })}`
    : null;

/**
 * Which credential served which model: one row per model, one column per credential, each cell
 * the events prox-usage counted for that pair. A credential opens in Auth Files, where its
 * actions live; a model opens its requests.
 */
export function RoutingView({
  data,
  reveal,
  onRevealChange,
  onModel,
}: {
  data: AnalyticsResponse;
  /** The browser's "Show emails" choice, shared with Quota. */
  reveal: boolean;
  onRevealChange?: (reveal: boolean) => void;
  onModel: (model: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const accounts = [...(data.accounts ?? [])].sort((a, b) => b.calls - a.calls);
  const routes = data.routes ?? [];
  if (!data.accounts) return <p className={styles.muted}>{t('analytics.routing.unsupported')}</p>;
  if (accounts.length === 0) return <p className={styles.muted}>{t('analytics.empty_chart')}</p>;
  // Models in the order of their server totals, busiest first.
  const rank = new Map(data.models.map((m) => [m.key, m.calls]));
  const models = [...new Set(routes.map((route) => route.model))]
    .map((model) => ({ model }))
    .sort((a, b) => (rank.get(b.model) ?? 0) - (rank.get(a.model) ?? 0));
  const cell = new Map(routes.map((r) => [`${r.model}\0${accountKey(r)}`, r]));
  const maximum = Math.max(0, ...routes.map((r) => r.calls));
  const name = (account: AnalyticsAccount) => accountName(account, reveal, t);
  return (
    <section className={`${styles.panel} ${styles.routing}`} aria-labelledby={id}>
      <div className={styles.trendHeader}>
        <h3 id={id}>{t('analytics.routing.title')}</h3>
        {onRevealChange && (
          <label className={styles.privacyToggle}>
            <input
              type="checkbox"
              checked={reveal}
              onChange={(event) => onRevealChange(event.target.checked)}
            />
            <IconEye size={16} aria-hidden="true" />
            {t('quota_pool.show_emails')}
          </label>
        )}
      </div>
      <p className={styles.muted}>{t('analytics.routing.help')}</p>
      <div className={styles.tableScroll} tabIndex={0} role="region" aria-labelledby={id}>
        <table className={styles.routingTable}>
          <thead>
            <tr>
              <th scope="col">{t('analytics.routing.model')}</th>
              {accounts.map((account) => {
                const link = authFilesLink(account);
                const ink =
                  account.providers.length === 1 ? providerInk(account.providers[0]) : null;
                return (
                  <th key={accountKey(account)} scope="col">
                    <span className={styles.routingAccount}>
                      {ink && (
                        <span
                          className={styles.categoryDot}
                          style={{ background: ink }}
                          aria-hidden="true"
                        />
                      )}
                      {link ? (
                        <Link to={link} title={t('analytics.routing.open_account')}>
                          {name(account)}
                        </Link>
                      ) : (
                        name(account)
                      )}
                    </span>
                    {/* The same account (or unlinked row) on two sources stays distinct: name the source. */}
                    {account.instance && (
                      <small className={styles.routingSource}>{account.instance}</small>
                    )}
                    <small>
                      {t('analytics.routing.account_totals', {
                        count: account.calls,
                        events: analyticsCompact(account.calls, i18n.language),
                        failed: analyticsCompact(account.failure_calls, i18n.language),
                      })}
                    </small>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {models.map(({ model }) => (
              <tr key={model}>
                <th scope="row">
                  <button
                    type="button"
                    className={styles.textButton}
                    onClick={() => onModel(model)}
                  >
                    {model}
                  </button>
                </th>
                {accounts.map((account) => {
                  const route = cell.get(`${model}\0${accountKey(account)}`);
                  return (
                    <td
                      key={accountKey(account)}
                      className={styles.routingCell}
                      data-level={heatLevel(route?.calls ?? 0, maximum)}
                      title={
                        route
                          ? t('analytics.routing.cell', {
                              count: route.calls,
                              events: analyticsNumber(route.calls, i18n.language),
                              failed: analyticsNumber(route.failure_calls, i18n.language),
                            })
                          : undefined
                      }
                    >
                      {route ? analyticsCompact(route.calls, i18n.language) : ''}
                      {route && route.failure_calls > 0 && (
                        <small className={styles.routingFailed}>
                          {t('analytics.failed_count', {
                            value: analyticsCompact(route.failure_calls, i18n.language),
                          })}
                        </small>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
