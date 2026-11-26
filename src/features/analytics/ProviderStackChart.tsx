import { memo, useCallback, useId, useMemo, useState, type SyntheticEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AnalyticsProviderBucket } from '@/domain/analytics/types';
import { providerFill } from '@/features/providers/identity';
import { niceMaximum } from './chartGeometry';
import { analyticsCompact, analyticsNumber, analyticsShortTime, analyticsTime } from './format';
import { localDayStart } from '@/domain/analytics/timeZone';
import { zoneName } from './displayZone';
import styles from './AnalyticsPage.module.scss';

const OTHER = '';
const DAY = 86_400_000;
type Bucket = { at: number; measured: boolean };

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
  zone = 'UTC',
  from,
}: {
  title: string;
  split: AnalyticsProviderBucket[];
  /** Every bucket in the window; an unmeasured one keeps its slot but shows no bar. */
  buckets: Bucket[];
  interval: number;
  /** The provider's display name, as the rest of the page shows it. */
  label: (provider: string) => string;
  /** The page's time zone for labels and day boundaries. */
  zone?: string;
  /** Query range start: a clipped first hourly bucket is labelled from its first in-range instant. */
  from?: number;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const daily = interval >= DAY;
  // Indexed once per answer, not per hover: tokens by bucket and group, and by bucket and provider.
  const { groups, byBucket, byProvider, providers } = useMemo(() => {
    const groupOf = (provider: string) => (providerFill(provider) ? provider : OTHER);
    const totals = new Map<string, number>();
    const byBucket = new Map<number, Map<string, number>>();
    const byProvider = new Map<string, number>();
    for (const part of split) {
      const group = groupOf(part.provider);
      totals.set(group, (totals.get(group) ?? 0) + part.total_tokens);
      const parts = byBucket.get(part.bucket_ms) ?? new Map<string, number>();
      parts.set(group, (parts.get(group) ?? 0) + part.total_tokens);
      byBucket.set(part.bucket_ms, parts);
      byProvider.set(`${part.bucket_ms}\0${part.provider}`, part.total_tokens);
    }
    // Legend order: largest first, Other last.
    const groups = [...totals.keys()].sort((a, b) =>
      a === OTHER ? 1 : b === OTHER ? -1 : totals.get(b)! - totals.get(a)!
    );
    const providers = [...new Set(split.map((part) => part.provider))].sort();
    return { groups, byBucket, byProvider, providers };
  }, [split]);
  const sum = (at: number) => [...(byBucket.get(at)?.values() ?? [])].reduce((a, b) => a + b, 0);
  const maximum = niceMaximum(Math.max(0, ...buckets.map((b) => sum(b.at))));
  const name = (group: string) =>
    group === OTHER ? t('analytics.provider_split.other') : label(group);
  const fill = (group: string) => providerFill(group) ?? 'var(--text-tertiary)';
  const labelAt = useCallback(
    (at: number) => (daily || from === undefined ? at : Math.max(at, from)),
    [daily, from]
  );
  // Stable across hovers, so the table below does not re-render while the pointer moves.
  const when = useCallback(
    (at: number) => {
      const displayAt = labelAt(at);
      return `${daily ? analyticsShortTime(displayAt, i18n.language, true, zone) : analyticsTime(displayAt, i18n.language, zone)} ${zoneName(zone, displayAt, i18n.language)}`;
    },
    [daily, i18n.language, labelAt, zone]
  );
  const measured = (at: number) => buckets.find((b) => b.at === at)?.measured !== false;
  const describe = (at: number) =>
    `${when(at)} · ${
      groups
        .filter((group) => byBucket.get(at)?.get(group))
        .map(
          (group) =>
            `${name(group)}: ${analyticsNumber(byBucket.get(at)!.get(group)!, i18n.language)}`
        )
        .join(' · ') || t(`analytics.provider_split.${measured(at) ? 'none' : 'unmeasured'}`)
    }`;
  const [inspected, setInspected] = useState<number | null>(null);
  // Bars share the width equally, so labels follow the bars, not the clock, about six of them.
  // Days sit under their bar; hours mark their boundary; hours over several days name the date
  // at each local midnight, so far-apart hours never look close.
  // A rolling day spans 25 hourly slots; only windows clearly longer than a day name dates.
  const multiDay = !daily && buckets.length > 26;
  const candidates = buckets
    .map(({ at }, index) => ({ at, left: ((index + (daily ? 0.5 : 0)) / buckets.length) * 100 }))
    .filter(({ at }) => !multiDay || localDayStart(zone, labelAt(at)) === labelAt(at));
  const every = Math.max(1, Math.ceil(candidates.length / 6));
  const ticks = candidates.filter((_, index) => index % every === 0);
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
        {/* Many bars drop the gaps between them, or the gaps alone would fill a phone's width. */}
        <div
          className={styles.stackBars}
          data-dense={buckets.length > 48 ? 'true' : undefined}
          aria-hidden="true"
          onMouseLeave={() => setInspected(null)}
        >
          {buckets.map(({ at, measured }) => (
            <span
              key={at}
              className={styles.stackBar}
              data-at={at}
              data-state={measured ? undefined : 'gap'}
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
            // Labels near an edge start or end at their tick instead of centring past the plot.
            <span
              key={tick.at}
              style={{
                left: `${tick.left}%`,
                transform:
                  tick.left < 12 ? 'none' : tick.left > 88 ? 'translateX(-100%)' : undefined,
              }}
            >
              {analyticsShortTime(labelAt(tick.at), i18n.language, daily || multiDay, zone)}
            </span>
          ))}
        </div>
      </div>
      <output className={styles.chartReadout} aria-hidden="true">
        {inspected !== null ? describe(inspected) : null}
      </output>
      <StackTable
        title={title}
        buckets={buckets}
        providers={providers}
        values={byProvider}
        label={label}
        when={when}
      />
    </section>
  );
}

/** The same slots as the plot, so quiet and unmeasured buckets are as visible as busy ones. */
const StackTable = memo(function StackTable({
  title,
  buckets,
  providers,
  values,
  label,
  when,
}: {
  title: string;
  buckets: Bucket[];
  providers: string[];
  values: ReadonlyMap<string, number>;
  label: (provider: string) => string;
  when: (at: number) => string;
}) {
  const { t, i18n } = useTranslation();
  // Mounted on first open: a month of hours across several providers is thousands of cells.
  const [opened, setOpened] = useState(false);
  return (
    <details
      className={styles.readout}
      onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary>{t('analytics.table_alternative')}</summary>
      <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={title}>
        <table>
          <caption className={styles.srOnly}>{title}</caption>
          <thead>
            <tr>
              <th scope="col">{t('analytics.bucket_category')}</th>
              {providers.map((provider) => (
                <th key={provider} scope="col">
                  {label(provider)}
                </th>
              ))}
            </tr>
          </thead>
          {opened && (
            <tbody>
              {buckets.map(({ at, measured }) => (
                <tr key={at}>
                  <th scope="row">{when(at)}</th>
                  {providers.map((provider) => (
                    <td key={provider}>
                      {measured
                        ? analyticsNumber(values.get(`${at}\0${provider}`) ?? 0, i18n.language)
                        : t('analytics.provider_split.unmeasured')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </div>
    </details>
  );
});
