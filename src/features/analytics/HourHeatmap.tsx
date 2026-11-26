import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { heatLevel, hourGrid, type HourCell } from './chartGeometry';
import { analyticsCompact, analyticsNumber, analyticsTime } from './format';
import { zoneName } from './displayZone';
import styles from './AnalyticsPage.module.scss';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const dayLabel = (day: number, locale: string, zone: string) =>
  new Intl.DateTimeFormat(locale, { timeZone: zone, month: 'short', day: 'numeric' }).format(day);
const hourLabel = (hour: number) => String(hour).padStart(2, '0');

/**
 * Events per hour, one row per day in the page's zone, so busy hours and quiet nights show.
 * Reads the hourly timeline prox-usage already returns; a daily view offers to switch to hours.
 * One tab stop: arrow keys move between hours, Enter opens that hour's requests.
 */
export function HourHeatmap({
  title,
  points,
  from,
  to,
  hourly,
  onSelect,
  onShowHourly,
  zone = 'UTC',
  weekly,
}: {
  title: string;
  /** Events per hour by bucket start: quiet hours as zero, unmeasured hours absent. */
  points: ReadonlyMap<number, number | null>;
  from: number;
  to: number;
  hourly: boolean;
  onSelect: (at: number) => void;
  onShowHourly: () => void;
  /** The page's time zone: rows are its local days, columns its hours. */
  zone?: string;
  /** prox-usage's events per local weekday and hour, summed over the range (hourly answers). */
  weekly?: { weekday: number; hour: number; calls: number }[];
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const rows = hourly ? hourGrid(points, from, to, zone) : [];
  const cells = rows.flatMap((row) => row.cells);
  const maximum = Math.max(0, ...cells.map((cell) => cell.value ?? 0));
  const inside = cells.filter((cell) => cell.state !== 'outside');
  const [active, setActive] = useState<number | null>(null);
  // Timestamps, resolved against the current cells, so a refreshed snapshot never shows an old
  // count or loses the tab stop.
  const [inspectedAt, setInspectedAt] = useState<number | null>(null);
  const inspected = inside.find((cell) => cell.at === inspectedAt);
  const grid = useRef<HTMLDivElement>(null);
  const [byWeekday, setByWeekday] = useState(false);
  // The tab stop is the hour last moved to, else the busiest hour, else the first in the window.
  const activeCell = inside.find((cell) => cell.at === active);
  const busiest = inside.reduce<HourCell | undefined>(
    (best, cell) => ((cell.value ?? -1) > (best?.value ?? -1) ? cell : best),
    undefined
  );
  const focusAt = activeCell?.at ?? busiest?.at ?? inside[0]?.at ?? null;
  // A refreshed snapshot can drop the focused hour; focus then moves to the new tab stop instead
  // of falling to the page. A removed element fires no blur, so the flag still says "inside".
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current || grid.current?.contains(document.activeElement)) return;
    grid.current?.querySelector<HTMLButtonElement>(`[data-at="${focusAt}"]`)?.focus();
  }, [focusAt]);
  const describe = (cell: HourCell) =>
    `${analyticsTime(cell.at, i18n.language, zone)} ${zoneName(zone, cell.at, i18n.language)}: ${
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
    setInspectedAt(target.at);
    grid.current?.querySelector<HTMLButtonElement>(`[data-at="${target.at}"]`)?.focus();
  };
  return (
    <section className={`${styles.panel} ${styles.heatmap}`} aria-labelledby={id}>
      <div className={styles.trendHeader}>
        <h3 id={id}>{title}</h3>
        {hourly && weekly && (
          <div role="group" aria-label={t('analytics.heatmap.view')} className={styles.segmented}>
            {[false, true].map((weekdays) => (
              <button
                key={String(weekdays)}
                type="button"
                aria-pressed={byWeekday === weekdays}
                onClick={() => setByWeekday(weekdays)}
              >
                {t(weekdays ? 'analytics.heatmap.weekdays' : 'analytics.heatmap.days')}
              </button>
            ))}
          </div>
        )}
      </div>
      {hourly && weekly && byWeekday ? (
        <WeekdayGrid title={title} weekly={weekly} />
      ) : !hourly ? (
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
            onMouseLeave={() => setInspectedAt(null)}
            onFocus={() => (focused.current = true)}
            onBlur={(event) => {
              if (!grid.current?.contains(event.relatedTarget)) focused.current = false;
            }}
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
                  {dayLabel(row.day, i18n.language, zone)}
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
                      onFocus={() => setInspectedAt(cell.at)}
                      onMouseEnter={() => setInspectedAt(cell.at)}
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
                    <th scope="col">
                      {t('analytics.heatmap.day', { zone: zoneName(zone, from, i18n.language) })}
                    </th>
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
                      <th scope="row">{dayLabel(row.day, i18n.language, zone)}</th>
                      {row.cells.map((cell) => (
                        <td key={cell.at}>
                          {cell.state === 'outside'
                            ? ''
                            : cell.state === 'gap'
                              ? t('analytics.heatmap.unmeasured')
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

/** Monday first; weekday 0 is Sunday, as prox-usage counts it. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/**
 * Events by weekday and hour, summed over the range in the page's zone: the usual week at a
 * glance. A cell spans several dates, so it opens nothing; the table repeats every value.
 */
function WeekdayGrid({
  title,
  weekly,
}: {
  title: string;
  weekly: { weekday: number; hour: number; calls: number }[];
}) {
  const { t, i18n } = useTranslation();
  const [inspected, setInspected] = useState<{ weekday: number; hour: number } | null>(null);
  const calls = new Map(weekly.map((slot) => [slot.weekday * 24 + slot.hour, slot.calls]));
  const maximum = Math.max(0, ...weekly.map((slot) => slot.calls));
  // 4 January 2026 was a Sunday: day names come from the locale, not a hard-coded list.
  const dayName = (weekday: number) =>
    new Intl.DateTimeFormat(i18n.language, { weekday: 'short', timeZone: 'UTC' }).format(
      Date.UTC(2026, 0, 4 + weekday)
    );
  const describe = (weekday: number, hour: number) =>
    `${dayName(weekday)} ${hourLabel(hour)}:00: ${t('analytics.heatmap.events', {
      value: analyticsNumber(calls.get(weekday * 24 + hour) ?? 0, i18n.language),
    })}`;
  return (
    <>
      <div className={styles.heatGrid} aria-hidden="true" onMouseLeave={() => setInspected(null)}>
        <span />
        {HOURS.map((hour) => (
          <span key={hour} className={styles.heatHour}>
            {hour % 3 === 0 ? hourLabel(hour) : ''}
          </span>
        ))}
        {WEEK.map((weekday) => (
          <div key={weekday} className={styles.heatRow}>
            <span className={styles.heatDay}>{dayName(weekday)}</span>
            {HOURS.map((hour) => (
              <span
                key={hour}
                className={styles.heatCell}
                data-level={heatLevel(calls.get(weekday * 24 + hour) ?? 0, maximum)}
                onMouseEnter={() => setInspected({ weekday, hour })}
              />
            ))}
          </div>
        ))}
      </div>
      <output className={styles.chartReadout} aria-hidden="true">
        {inspected ? describe(inspected.weekday, inspected.hour) : null}
      </output>
      <details className={styles.readout}>
        <summary>{t('analytics.table_alternative')}</summary>
        <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={title}>
          <table>
            <caption className={styles.srOnly}>{title}</caption>
            <thead>
              <tr>
                <th scope="col">{t('analytics.heatmap.weekday')}</th>
                {HOURS.map((hour) => (
                  <th key={hour} scope="col">
                    {hourLabel(hour)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WEEK.map((weekday) => (
                <tr key={weekday}>
                  <th scope="row">{dayName(weekday)}</th>
                  {HOURS.map((hour) => (
                    <td key={hour}>
                      {analyticsNumber(calls.get(weekday * 24 + hour) ?? 0, i18n.language)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
