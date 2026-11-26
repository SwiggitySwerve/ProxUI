import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { providerFill, providerInk } from '@/features/providers/identity';
import { analyticsCompact, analyticsMoney, analyticsNumber } from './format';
import type { ChartDatum } from './chartGeometry';
import styles from './AnalyticsPage.module.scss';

/**
 * Categories ranked by their server-supplied value as horizontal bars, so long names stay
 * readable. Missing values sort last and draw no bar; the table repeats every value.
 *
 * With `failures`, each bar is the category's events and its failed events are drawn as a
 * hatched part from the start of the bar, on the same scale, so failures compare across rows.
 * The failed count opens those failed events. Counts come from prox-usage; no rate is computed.
 */
export function AnalyticsChart({
  title,
  data,
  format = 'compact',
  onSelect,
  failures,
}: {
  title: string;
  data: ChartDatum[];
  /** compact: 12.5K counts; exact: durations; money: dollars to the cent. */
  format?: 'compact' | 'exact' | 'money';
  onSelect?: (key: string) => void;
  /** Draw each datum's `failed` count; `onSelect` opens a category's failed events. */
  failures?: { onSelect: (key: string) => void };
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [inspectedKey, setInspectedKey] = useState<string | null>(null);
  const readout = data.find((point) => point.key === inspectedKey);
  const maximum = Math.max(0, ...data.map((d) => d.value ?? 0));
  const ranked = [...data].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  const currency = format === 'money';
  const exact = (value: number | null) => analyticsNumber(value, i18n.language, currency);
  const shown = (value: number | null) =>
    format === 'money'
      ? analyticsMoney(value, i18n.language)
      : format === 'exact'
        ? analyticsNumber(value, i18n.language)
        : analyticsCompact(value, i18n.language);
  const width = (value: number) => `${maximum > 0 ? (value / maximum) * 100 : 0}%`;
  const failedOf = (d: ChartDatum) => d.failed ?? 0;
  const described = (d: ChartDatum) =>
    failures
      ? t('analytics.failure_readout', {
          label: d.label,
          events: exact(d.value),
          failed: exact(failedOf(d)),
        })
      : `${d.label}: ${exact(d.value)}`;
  const failedButton = (d: ChartDatum, compact: boolean): ReactNode =>
    failedOf(d) > 0 ? (
      <button
        type="button"
        className={styles.failedLink}
        title={exact(failedOf(d))}
        onClick={() => failures?.onSelect(d.key)}
      >
        {/* The visible text starts the accessible name, so voice control can say what it sees. */}
        {t('analytics.failed_count', {
          value: compact ? analyticsCompact(failedOf(d), i18n.language) : exact(failedOf(d)),
        })}{' '}
        <span className={styles.srOnly}>{t('analytics.failed_for', { label: d.label })}</span>
      </button>
    ) : (
      <span className={styles.failedNone}>{t('analytics.failed_count', { value: exact(0) })}</span>
    );
  return (
    <section className={`${styles.panel} ${styles.breakdown}`} aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {data.length === 0 ? (
        <p className={styles.muted}>{t('analytics.empty_chart')}</p>
      ) : (
        <>
          <ol className={styles.ranked}>
            {ranked.map((d) => {
              // Colour comes from the row's provider, never its key: a model may share a name.
              const ink = providerInk(d.provider);
              const label = (
                <span className={styles.rankedLabel} title={d.label}>
                  {ink && (
                    <span
                      className={styles.categoryDot}
                      style={{ background: ink }}
                      aria-hidden="true"
                    />
                  )}
                  {d.label}
                </span>
              );
              // A missing value draws no track: an empty track would read as zero.
              const track = d.value !== null && (
                <span
                  className={styles.rankedTrack}
                  data-split={failures ? 'true' : undefined}
                  aria-hidden="true"
                >
                  {failures && failedOf(d) > 0 && (
                    <span
                      className={styles.failedPart}
                      style={{ width: width(Math.min(failedOf(d), d.value)) }}
                    />
                  )}
                  <span
                    style={{
                      width: failures
                        ? width(Math.max(0, d.value - failedOf(d)))
                        : `${maximum > 0 ? Math.max(0.5, (d.value / maximum) * 100) : 0}%`,
                      background: providerFill(d.provider) ?? undefined,
                    }}
                  />
                </span>
              );
              const inspect = () => setInspectedKey(d.key);
              // The name's button covers the row; the failed count sits above it as a second action.
              return (
                <li key={d.key}>
                  <div
                    className={styles.rankedRow}
                    data-failures={failures ? 'true' : undefined}
                    onMouseEnter={inspect}
                  >
                    {onSelect ? (
                      <button
                        type="button"
                        className={styles.rankedHit}
                        aria-label={described(d)}
                        onFocus={inspect}
                        onClick={() => onSelect(d.key)}
                      >
                        {label}
                      </button>
                    ) : (
                      label
                    )}
                    <strong title={exact(d.value)} data-unavailable={d.value === null}>
                      {shown(d.value)}
                    </strong>
                    {failures && failedButton(d, true)}
                    {track}
                  </div>
                </li>
              );
            })}
          </ol>
          <output className={styles.chartReadout} aria-live="polite">
            {readout ? described(readout) : null}
          </output>
          {data.some((d) => d.value !== null) && (
            <details className={styles.readout}>
              <summary>{t('analytics.table_alternative')}</summary>
              <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={title}>
                <table>
                  <caption className={styles.srOnly}>{title}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('analytics.bucket_category')}</th>
                      <th scope="col">{failures ? t('analytics.metrics.calls') : title}</th>
                      {failures && <th scope="col">{t('analytics.metrics.failure_calls')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((d) => (
                      <tr key={d.key}>
                        <th scope="row">
                          {onSelect ? (
                            <button
                              type="button"
                              className={styles.textButton}
                              onClick={() => onSelect(d.key)}
                            >
                              {d.label}
                            </button>
                          ) : (
                            d.label
                          )}
                        </th>
                        <td>
                          {d.value === null ? t('analytics.unavailable_value') : exact(d.value)}
                        </td>
                        {failures && <td>{failedButton(d, false)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
