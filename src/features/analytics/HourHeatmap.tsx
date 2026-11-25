import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { heatLevel, hourGrid, type HourCell } from './chartGeometry';
import { analyticsCompact, analyticsNumber, analyticsTime } from './format';
import styles from './AnalyticsPage.module.scss';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const dayLabel = (day: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(day);
const hourLabel = (hour: number) => String(hour).padStart(2, '0');

/**
 * Events per UTC hour, one row per day, so busy hours and quiet nights show at a glance.
 * Reads the hourly timeline prox-usage already returns; a daily view offers to switch to hours.
 * One tab stop: arrow keys move between hours, Enter opens that hour's requests.
 */
export function HourHeatmap({
  title,
  points,
  from,
  to,
  hourly,
  rawComplete,
  onSelect,
  onShowHourly,
}: {
  title: string;
  /** The hourly timeline's event counts by bucket start. */
  points: ReadonlyMap<number, number | null>;
  from: number;
  to: number;
  hourly: boolean;
  rawComplete: boolean;
  onSelect: (at: number) => void;
  onShowHourly: () => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const rows = hourly ? hourGrid(points, from, to, rawComplete) : [];
  const cells = rows.flatMap((row) => row.cells);
  const maximum = Math.max(0, ...cells.map((cell) => cell.value ?? 0));
  const inside = cells.filter((cell) => cell.state !== 'outside');
  const [active, setActive] = useState<number | null>(null);
  const [inspected, setInspected] = useState<HourCell | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  // The tab stop is the hour last moved to, else the busiest hour, else the first in the window.
  const busiest = inside.reduce<HourCell | undefined>(
    (best, cell) => ((cell.value ?? -1) > (best?.value ?? -1) ? cell : best),
    undefined
  );
  const focusAt = active ?? busiest?.at ?? null;
  const describe = (cell: HourCell) =>
    `${analyticsTime(cell.at, i18n.language)} UTC: ${
      cell.state === 'gap'
        ? t('analytics.heatmap.unmeasured')
        : t('analytics.heatmap.events', { value: analyticsNumber(cell.value, i18n.language) })
    }`;
  const move = (event: KeyboardEvent, cell: HourCell) => {
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -24,
      ArrowDown: 24,
    };
    const index = cells.indexOf(cell);
    let next: number | undefined;
    if (event.key in steps) {
      next = index + steps[event.key];
      while (cells[next]?.state === 'outside') next += Math.sign(steps[event.key]);
    } else if (event.key === 'Home') next = cells.indexOf(inside[0]);
    else if (event.key === 'End') next = cells.indexOf(inside[inside.length - 1]);
    else return;
    event.preventDefault();
    const target = cells[next];
    if (!target || target.state === 'outside') return;
    setActive(target.at);
    setInspected(target);
    grid.current?.querySelector<HTMLButtonElement>(`[data-at="${target.at}"]`)?.focus();
  };
  return (
    <section className={`${styles.panel} ${styles.heatmap}`} aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {!hourly ? (
        <p className={styles.muted}>
          {t('analytics.heatmap.daily')}{' '}
          <button type="button" className={styles.textButton} onClick={onShowHourly}>
            {t('analytics.heatmap.show_hourly')}
          </button>
        </p>
      ) : (
        <>
          <div
            ref={grid}
            className={styles.heatGrid}
            role="group"
            aria-label={`${title}. ${t('analytics.heatmap.keys')}`}
            onMouseLeave={() => setInspected(null)}
          >
            <span aria-hidden="true" />
            {HOURS.map((hour) => (
              <span key={hour} className={styles.heatHour} aria-hidden="true">
                {hour % 3 === 0 ? hourLabel(hour) : ''}
              </span>
            ))}
            {rows.map((row) => (
              <div key={row.day} className={styles.heatRow}>
                <span className={styles.heatDay} aria-hidden="true">
                  {dayLabel(row.day, i18n.language)}
                </span>
                {row.cells.map((cell) =>
                  cell.state === 'outside' ? (
                    <span key={cell.at} className={styles.heatCell} data-state="outside" />
                  ) : (
                    <button
                      key={cell.at}
                      type="button"
                      className={styles.heatCell}
                      data-at={cell.at}
                      data-state={cell.state}
                      data-level={heatLevel(cell.value, maximum)}
                      tabIndex={cell.at === focusAt ? 0 : -1}
                      aria-label={describe(cell)}
                      onFocus={() => setInspected(cell)}
                      onMouseEnter={() => setInspected(cell)}
                      onKeyDown={(event) => move(event, cell)}
                      onClick={() => onSelect(cell.at)}
                    />
                  )
                )}
              </div>
            ))}
          </div>
          <div className={styles.heatFooter}>
            <span className={styles.heatScale} aria-hidden="true">
              0
              {[1, 2, 3, 4].map((level) => (
                <span key={level} className={styles.heatCell} data-level={level} />
              ))}
              {analyticsCompact(maximum, i18n.language)}
            </span>
            <output className={styles.chartReadout} aria-live="polite">
              {inspected ? describe(inspected) : null}
            </output>
          </div>
          <details className={styles.readout}>
            <summary>{t('analytics.table_alternative')}</summary>
            <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={title}>
              <table>
                <caption className={styles.srOnly}>{title}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('analytics.heatmap.day')}</th>
                    {HOURS.map((hour) => (
                      <th key={hour} scope="col">
                        {hourLabel(hour)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.day}>
                      <th scope="row">{dayLabel(row.day, i18n.language)}</th>
                      {row.cells.map((cell) => (
                        <td key={cell.at}>
                          {cell.state === 'outside'
                            ? ''
                            : cell.state === 'gap'
                              ? '–'
                              : analyticsNumber(cell.value, i18n.language)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
