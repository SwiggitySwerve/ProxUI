import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AnalyticsProviderBucket } from '@/domain/analytics/types';
import { providerFill } from '@/features/providers/identity';
import { niceMaximum } from './chartGeometry';
import { analyticsCompact, analyticsNumber, analyticsShortTime, analyticsTime } from './format';
import styles from './AnalyticsPage.module.scss';

const OTHER = '';

/**
 * One bar per bucket, stacked by provider, from prox-usage's provider split (it adds up to the
 * timeline). Providers with a colour keep their textured fill; the rest share one "Other" part.
 * The bars only show: the trend above opens each bucket's requests, and hundreds of bars cannot
 * each be a touch target. Each named provider in the legend opens its Quota, where its accounts
 * are managed. The table repeats every value.
 */
export function ProviderStackChart({
  title,
  split,
  buckets,
  interval,
  label,
}: {
  title: string;
  split: AnalyticsProviderBucket[];
  /** Every bucket in the window; an unmeasured one keeps its slot but shows no bar. */
  buckets: { at: number; measured: boolean }[];
  interval: number;
  /** The provider's display name, as the rest of the page shows it. */
  label: (provider: string) => string;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const daily = interval >= 86_400_000;
  const groupOf = (provider: string) => (providerFill(provider) ? provider : OTHER);
  // Legend order: largest first, Other last.
  const totals = new Map<string, number>();
  for (const part of split)
    totals.set(
      groupOf(part.provider),
      (totals.get(groupOf(part.provider)) ?? 0) + part.total_tokens
    );
  const groups = [...totals.keys()].sort((a, b) =>
    a === OTHER ? 1 : b === OTHER ? -1 : totals.get(b)! - totals.get(a)!
  );
  const byBucket = new Map<number, Map<string, number>>();
  for (const part of split) {
    const parts = byBucket.get(part.bucket_ms) ?? new Map<string, number>();
    parts.set(groupOf(part.provider), (parts.get(groupOf(part.provider)) ?? 0) + part.total_tokens);
    byBucket.set(part.bucket_ms, parts);
  }
  const unmeasured = new Set(buckets.filter((b) => !b.measured).map((b) => b.at));
  const sum = (at: number) => [...(byBucket.get(at)?.values() ?? [])].reduce((a, b) => a + b, 0);
  const maximum = niceMaximum(Math.max(0, ...buckets.map((b) => sum(b.at))));
  const name = (group: string) =>
    group === OTHER ? t('analytics.provider_split.other') : label(group);
  const fill = (group: string) => providerFill(group) ?? 'var(--text-tertiary)';
  const describe = (at: number) =>
    `${when(at)} · ${
      groups
        .filter((group) => byBucket.get(at)?.get(group))
        .map(
          (group) =>
            `${name(group)}: ${analyticsNumber(byBucket.get(at)!.get(group)!, i18n.language)}`
        )
        .join(' · ') || t(`analytics.provider_split.${unmeasured.has(at) ? 'unmeasured' : 'none'}`)
    }`;
  const [inspected, setInspected] = useState<number | null>(null);
  const when = (at: number) =>
    daily
      ? `${analyticsShortTime(at, i18n.language, true)} UTC`
      : `${analyticsTime(at, i18n.language)} UTC`;
  // Bars share the width equally, so labels follow the bars, not the clock: about six of them,
  // under the day they name or at the hour boundary they name.
  const every = Math.max(1, Math.ceil(buckets.length / 6));
  const ticks = buckets
    .map(({ at }, index) => ({ at, left: ((index + (daily ? 0.5 : 0)) / buckets.length) * 100 }))
    .filter((_, index) => index % every === 0);
  return (
    <section className={`${styles.panel} ${styles.providerStack}`} aria-labelledby={id}>
      <div className={styles.trendHeader}>
        <h3 id={id}>{title}</h3>
        <ul className={styles.legend} aria-label={t('analytics.legend')}>
          {groups.map((group) => (
            <li key={group || 'other'}>
              <span
                className={styles.stackSwatch}
                style={{ background: fill(group) }}
                aria-hidden="true"
              />
              {group === OTHER ? (
                name(group)
              ) : (
                <Link
                  to={`/quota?${new URLSearchParams({ provider: group })}`}
                  title={t('analytics.provider_split.open_quota', { provider: name(group) })}
                >
                  {name(group)}
                </Link>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className={styles.stackPlot}>
        <span className={styles.stackMax} aria-hidden="true">
          {analyticsCompact(maximum, i18n.language)}
        </span>
        <div
          className={styles.stackBars}
          aria-hidden="true"
          onMouseLeave={() => setInspected(null)}
        >
          {buckets.map(({ at }) => (
            <span
              key={at}
              className={styles.stackBar}
              data-at={at}
              data-state={unmeasured.has(at) ? 'gap' : undefined}
              onMouseEnter={() => setInspected(at)}
            >
              {groups.map((group) => {
                const value = byBucket.get(at)?.get(group);
                return value ? (
                  <span
                    key={group || 'other'}
                    style={{ height: `${(value / maximum) * 100}%`, background: fill(group) }}
                  />
                ) : null;
              })}
            </span>
          ))}
        </div>
        <div className={styles.stackTicks} aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick.at} style={{ left: `${tick.left}%` }}>
              {analyticsShortTime(tick.at, i18n.language, daily)}
            </span>
          ))}
        </div>
      </div>
      <output className={styles.chartReadout} aria-hidden="true">
        {inspected !== null ? describe(inspected) : null}
      </output>
      <details className={styles.readout}>
        <summary>{t('analytics.table_alternative')}</summary>
        <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={title}>
          <table>
            <caption className={styles.srOnly}>{title}</caption>
            <thead>
              <tr>
                <th scope="col">{t('analytics.bucket_category')}</th>
                {[...new Set(split.map((part) => part.provider))].sort().map((provider) => (
                  <th key={provider} scope="col">
                    {label(provider)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...new Set(split.map((part) => part.bucket_ms))].map((at) => (
                <tr key={at}>
                  <th scope="row">{analyticsTime(at, i18n.language)}</th>
                  {[...new Set(split.map((part) => part.provider))].sort().map((provider) => (
                    <td key={provider}>
                      {analyticsNumber(
                        split.find((part) => part.bucket_ms === at && part.provider === provider)
                          ?.total_tokens ?? 0,
                        i18n.language
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
