import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { inRangeBucketTime, zoneOffsetMinutes } from '@/domain/analytics/timeZone';
import { heatLevel, hourGrid, type HourCell, type HourOccurrence } from './chartGeometry';
import { analyticsCompact, analyticsNumber, analyticsTimeWithZone } from './format';
import { rangeZoneLabel, zoneName } from './displayZone';
import styles from './AnalyticsPage.module.scss';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const dayLabel = (day: number, locale: string, zone: string) =>
  new Intl.DateTimeFormat(locale, { timeZone: zone, month: 'short', day: 'numeric' }).format(day);
const hourLabel = (hour: number) => String(hour).padStart(2, '0');

function cellOccurrences(cell: HourCell): HourOccurrence[] {
  if (cell.at === null || cell.state === 'skipped' || cell.state === 'outside') return [];
  const first: HourOccurrence = {
    at: cell.at,
    value: cell.value,
    state: cell.state,
  };
  return cell.repeat ? [first, cell.repeat] : [first];
}

interface InteractiveSlot extends HourOccurrence {
  row: number;
  hour: number;
}

type WeekdaySlotState = 'value' | 'gap' | 'outside';

function HeatScale({ maximum, hasSkipped = false }: { maximum: number; hasSkipped?: boolean }) {
  const { t, i18n } = useTranslation();
  return (
    <span className={styles.heatScale} aria-hidden="true">
      0
      {[0, 1, 2, 3, 4].map((level) => (
        <span key={level} className={styles.heatCell} data-level={level} />
      ))}
      {analyticsCompact(maximum, i18n.language)}
      <span className={styles.heatScaleKey}>
        <span className={styles.heatCell} data-state="gap" />
        {t('analytics.heatmap.unmeasured')}
      </span>
      {hasSkipped && (
        <span className={styles.heatScaleKey}>
          <span className={styles.heatCell} data-state="skipped" />
          {t('analytics.heatmap.skipped')}
        </span>
      )}
    </span>
  );
}

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
  /** The page's time zone: rows are its local days, columns its wall-clock hours. */
  zone?: string;
  /** prox-usage's events per local weekday and hour, summed over the range (hourly answers). */
  weekly?: { weekday: number; hour: number; calls: number }[];
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const rows = hourly ? hourGrid(points, from, to, zone) : [];
  const allOccurrences = rows.flatMap((row) => row.cells.flatMap(cellOccurrences));
  const maximum = Math.max(0, ...allOccurrences.map((occ) => occ.value ?? 0));
  const hasSkipped = rows.some((row) => row.cells.some((cell) => cell.state === 'skipped'));
  // Per (weekday, hour) coverage state from the same range/points: outside the range stays blank,
  // and unmeasured slots under partial coverage stay hatched gaps rather than reading as zero.
  const weekdayMeasured = new Array<number>(7 * 24).fill(0);
  const weekdayGaps = new Array<number>(7 * 24).fill(0);
  for (const row of rows) {
    const weekday = new Date(row.day + zoneOffsetMinutes(zone, row.day) * 60_000).getUTCDay();
    for (let hour = 0; hour < 24; hour++) {
      for (const occ of cellOccurrences(row.cells[hour])) {
        const slot = weekday * 24 + hour;
        if (occ.state === 'value') weekdayMeasured[slot] += 1;
        else weekdayGaps[slot] += 1;
      }
    }
  }
  const weekdayStates: WeekdaySlotState[] = weekdayMeasured.map((measured, slot) =>
    measured > 0 ? 'value' : weekdayGaps[slot] > 0 ? 'gap' : 'outside'
  );
  const inside: InteractiveSlot[] = rows.flatMap((row, rowIndex) =>
    row.cells.flatMap((cell, hour) =>
      cellOccurrences(cell).map((occ) => ({ ...occ, row: rowIndex, hour }))
    )
  );
  const [active, setActive] = useState<number | null>(null);
  // Timestamps, resolved against the current slots, so a refreshed snapshot never shows an old
  // count or loses the tab stop.
  const [inspectedAt, setInspectedAt] = useState<number | null>(null);
  const inspected = inside.find((slot) => slot.at === inspectedAt);
  const grid = useRef<HTMLDivElement>(null);
  const [byWeekday, setByWeekday] = useState(false);
  // The tab stop is the hour last moved to, else the busiest hour, else the first in the window.
  const activeSlot = inside.find((slot) => slot.at === active);
  const busiest = inside.reduce<InteractiveSlot | undefined>(
    (best, slot) => ((slot.value ?? -1) > (best?.value ?? -1) ? slot : best),
    undefined
  );
  const focusAt = activeSlot?.at ?? busiest?.at ?? inside[0]?.at ?? null;
  // A refreshed snapshot can drop the focused hour; focus then moves to the new tab stop instead
  // of falling to the page. A removed element fires no blur, so the flag still says "inside".
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current || grid.current?.contains(document.activeElement)) return;
    grid.current?.querySelector<HTMLButtonElement>(`[data-at="${focusAt}"]`)?.focus();
  }, [focusAt]);
  const labelAt = (at: number) => inRangeBucketTime(at, from);
  const describe = (occ: HourOccurrence) => {
    const at = labelAt(occ.at);
    return `${analyticsTimeWithZone(at, i18n.language, zone)}: ${
      occ.state === 'gap'
        ? t('analytics.heatmap.unmeasured')
        : t('analytics.heatmap.events', {
            count: occ.value ?? 0,
            value: analyticsNumber(occ.value, i18n.language),
          })
    }`;
  };
  const move = (event: KeyboardEvent, current: InteractiveSlot) => {
    const index = inside.findIndex((slot) => slot.at === current.at);
    let target: InteractiveSlot | undefined;
    if (event.key === 'ArrowLeft') target = inside[index - 1];
    else if (event.key === 'ArrowRight') target = inside[index + 1];
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const step = event.key === 'ArrowUp' ? -1 : 1;
      for (let r = current.row + step; r >= 0 && r < rows.length; r += step) {
        const match = inside.find((slot) => slot.row === r && slot.hour === current.hour);
        if (match) {
          target = match;
          break;
        }
      }
    } else if (event.key === 'Home') target = inside[0];
    else if (event.key === 'End') target = inside[inside.length - 1];
    else return;
    event.preventDefault();
    if (!target) return;
    setActive(target.at);
    setInspectedAt(target.at);
    grid.current?.querySelector<HTMLButtonElement>(`[data-at="${target.at}"]`)?.focus();
  };
  const renderOccurrence = (occ: HourOccurrence, rowIndex: number, hour: number) => (
    <button
      key={occ.at}
      type="button"
      className={styles.heatCell}
      data-at={occ.at}
      data-state={occ.state}
      data-level={heatLevel(occ.value, maximum)}
      tabIndex={occ.at === focusAt ? 0 : -1}
      aria-label={describe(occ)}
      onFocus={() => setInspectedAt(occ.at)}
      onMouseEnter={() => setInspectedAt(occ.at)}
      onKeyDown={(event) => move(event, { ...occ, row: rowIndex, hour })}
      onClick={() => onSelect(occ.at)}
    />
  );
  const formatTableCell = (cell: HourCell) => {
    if (cell.state === 'skipped') return t('analytics.heatmap.skipped');
    const occurrences = cellOccurrences(cell);
    if (occurrences.length === 0) return '';
    if (occurrences.length === 1) {
      const [occ] = occurrences;
      return occ.state === 'gap'
        ? t('analytics.heatmap.unmeasured')
        : analyticsNumber(occ.value, i18n.language);
    }
    return occurrences
      .map(
        (occ) =>
          `${occ.state === 'gap' ? t('analytics.heatmap.unmeasured') : analyticsNumber(occ.value, i18n.language)} (${zoneName(zone, labelAt(occ.at), i18n.language)})`
      )
      .join(' / ');
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
        <WeekdayGrid title={title} weekly={weekly} states={weekdayStates} />
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
            {rows.map((row, rowIndex) => (
              <div key={row.day} className={styles.heatRow}>
                <span className={styles.heatDay} aria-hidden="true">
                  {dayLabel(row.day, i18n.language, zone)}
                </span>
                {row.cells.map((cell, hour) => {
                  if (cell.state === 'skipped') {
                    return (
                      <span
                        key={`skipped-${row.day}-${hour}`}
                        className={styles.heatCell}
                        data-state="skipped"
                        title={t('analytics.heatmap.skipped')}
                      />
                    );
                  }
                  const occurrences = cellOccurrences(cell);
                  if (occurrences.length === 0) {
                    return (
                      <span
                        key={`outside-${row.day}-${hour}`}
                        className={styles.heatCell}
                        data-state="outside"
                      />
                    );
                  }
                  if (occurrences.length === 1) {
                    return renderOccurrence(occurrences[0], rowIndex, hour);
                  }
                  return (
                    <span key={`split-${row.day}-${hour}`} className={styles.heatSplit}>
                      {occurrences.map((occ) => renderOccurrence(occ, rowIndex, hour))}
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
          <div className={styles.heatFooter}>
            <HeatScale maximum={maximum} hasSkipped={hasSkipped} />
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
                      {t('analytics.heatmap.day', {
                        zone: rangeZoneLabel(zone, from, to, i18n.language),
                      })}
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
                      {row.cells.map((cell, hour) => (
                        <td key={`${row.day}-${hour}`}>{formatTableCell(cell)}</td>
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
  states,
}: {
  title: string;
  weekly: { weekday: number; hour: number; calls: number }[];
  states: readonly WeekdaySlotState[];
}) {
  const { t, i18n } = useTranslation();
  const [inspected, setInspected] = useState<{ weekday: number; hour: number } | null>(null);
  const calls = new Map(weekly.map((slot) => [slot.weekday * 24 + slot.hour, slot.calls]));
  const maximum = Math.max(
    0,
    ...weekly
      .filter((slot) => states[slot.weekday * 24 + slot.hour] === 'value')
      .map((s) => s.calls)
  );
  // 4 January 2026 was a Sunday: day names come from the locale, not a hard-coded list.
  const dayName = (weekday: number) =>
    new Intl.DateTimeFormat(i18n.language, { weekday: 'short', timeZone: 'UTC' }).format(
      Date.UTC(2026, 0, 4 + weekday)
    );
  const describe = (weekday: number, hour: number) => {
    const slot = weekday * 24 + hour;
    const state = states[slot];
    if (state === 'gap')
      return `${dayName(weekday)} ${hourLabel(hour)}:00: ${t('analytics.heatmap.unmeasured')}`;
    const count = calls.get(slot) ?? 0;
    return `${dayName(weekday)} ${hourLabel(hour)}:00: ${t('analytics.heatmap.events', {
      count,
      value: analyticsNumber(count, i18n.language),
    })}`;
  };
  const tableValue = (weekday: number, hour: number) => {
    const slot = weekday * 24 + hour;
    const state = states[slot];
    if (state === 'outside') return '';
    if (state === 'gap') return t('analytics.heatmap.unmeasured');
    return analyticsNumber(calls.get(slot) ?? 0, i18n.language);
  };
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
            {HOURS.map((hour) => {
              const slot = weekday * 24 + hour;
              const state = states[slot];
              if (state === 'outside') {
                return <span key={hour} className={styles.heatCell} data-state="outside" />;
              }
              return (
                <span
                  key={hour}
                  className={styles.heatCell}
                  data-state={state}
                  data-level={state === 'value' ? heatLevel(calls.get(slot) ?? 0, maximum) : 0}
                  onMouseEnter={() => setInspected({ weekday, hour })}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className={styles.heatFooter}>
        <HeatScale maximum={maximum} />
        <output className={styles.chartReadout} aria-hidden="true">
          {inspected ? describe(inspected.weekday, inspected.hour) : null}
        </output>
      </div>
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
                    <td key={hour}>{tableValue(weekday, hour)}</td>
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
