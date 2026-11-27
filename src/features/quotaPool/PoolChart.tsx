import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PoolDashboard, QuotaPool } from '@/domain/quotaPool/types';
import {
  axisTicks,
  chartFrame as defaultChartFrame,
  fitChartFrame,
  chartGeometry,
  chartSamples,
  dayTicks,
  hourTicks,
  inRange,
  viewRange,
  metricField,
  type ChartMode,
} from './chartGeometry';
import { formatPoolDate, formatPoolNumber, formatPoolTick } from './presentation';
import { PoolTracePaths } from './PoolTracePaths';
import { poolProviderLabel, poolProviderStyle } from './providerPresentation';
import styles from './QuotaPoolPage.module.scss';

interface ChartProps {
  dashboard: Pick<PoolDashboard, 'fromMs' | 'toMs' | 'nowMs' | 'window'>;
  mode: ChartMode;
  savedData?: boolean;
  minimized?: boolean;
}

export function PoolChart({
  pool,
  dashboard,
  mode,
  savedData = false,
  minimized = false,
}: ChartProps & { pool: QuotaPool }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(defaultChartFrame.width);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => {
      const next = element.getBoundingClientRect().width;
      if (next > 0) setWidth(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const unit = t(`quota_pool.${mode === 'remaining' ? 'points' : 'points_hour'}`);
  // Phones still get a start, middle and end date plus one between, so a range reads at a glance.
  const tickCount = width < 480 ? 4 : width < 850 ? 5 : 8;
  // null = not yet inspected: show the newest recorded sample, i.e. the current reading.
  const [inspected, setInspected] = useState<number | null>(null);
  const { fromMs, toMs } = viewRange(dashboard, mode);
  const { nowMs } = dashboard;
  // Two days or less: one tick per few hours instead of one per day.
  const hourly = toMs - fromMs <= 2.5 * 86_400_000;
  const field = metricField[mode];
  const samples = inRange(chartSamples(pool.recorded, pool.projected, mode), fromMs, toMs);
  const sparseProjection = samples.filter((sample) => sample.projected).length < 3;
  const axis = chartGeometry(samples, mode, pool.capacityPoints, fromMs, toMs);
  const yTicks = axisTicks(axis.min, axis.max);
  const numberChars = Math.max(
    ...[pool.capacityPoints, ...yTicks].map(
      (value) => formatPoolNumber(value, i18n.language).length
    )
  );
  const alignUnitEnd = width >= 600;
  const baseFrame = fitChartFrame(
    width,
    savedData || pool.forecastState !== 'ready' || mode !== 'remaining',
    // One reading draws a point, not a line, so it gets the compact height.
    minimized || pool.recorded.length === 1,
    alignUnitEnd ? Math.max(numberChars, Math.ceil(unit.length * 0.72)) : numberChars
  );
  const number = (value: number | null) => formatPoolNumber(value, i18n.language);
  const date = (value: number) => formatPoolDate(value, i18n.language);
  const visible = (at: number | null): at is number => at !== null && at >= fromMs && at <= toMs;
  const projectX = (atMs: number) =>
    baseFrame.left +
    ((atMs - fromMs) / Math.max(1, toMs - fromMs)) * (baseFrame.right - baseFrame.left);
  const snapshotText = t(`quota_pool.${savedData ? 'saved_snapshot' : 'snapshot'}`);
  const snapshotX = visible(nowMs) ? projectX(nowMs) : null;
  const snapW = snapshotText.length * 8.2 + 20;
  // A scheduled reset just after Snapshot keeps its label centred over its own tick, so Snapshot's
  // label moves to the left of its line instead of sitting under that reset label (G10b).
  const resetJustAfter =
    snapshotX !== null &&
    mode === 'remaining' &&
    pool.resets.some((reset) => {
      if (!visible(reset.atMs) || reset.gainPoints <= 0) return false;
      const gap = projectX(reset.atMs) - snapshotX;
      return gap >= 0 && gap < snapW / 2 + 40;
    });
  const snapshotAnchor =
    snapshotX === null
      ? 'middle'
      : baseFrame.right - snapshotX < 60 || (resetJustAfter && snapshotX - baseFrame.left >= snapW)
        ? 'end'
        : snapshotX - baseFrame.left < 60
          ? 'start'
          : 'middle';
  const snapLeft =
    snapshotX === null
      ? Infinity
      : snapshotAnchor === 'start'
        ? snapshotX - 8
        : snapshotAnchor === 'end'
          ? snapshotX - snapW
          : snapshotX - snapW / 2;
  const snapRight =
    snapshotX === null
      ? -Infinity
      : snapshotAnchor === 'start'
        ? snapshotX + snapW
        : snapshotAnchor === 'end'
          ? snapshotX + 8
          : snapshotX + snapW / 2;
  const axisUnitRight = alignUnitEnd ? baseFrame.left - 10 : unit.length * 7.5 + 12;
  const rawResets = (mode === 'remaining' ? pool.resets : [])
    .filter((reset) => visible(reset.atMs) && reset.gainPoints > 0)
    .map((reset) => {
      const rx = projectX(reset.atMs);
      const text = `+${number(reset.gainPoints)}`;
      const halfW = text.length * 4.5 + 7;
      const labelX = Math.max(halfW + 4, Math.min(baseFrame.width - halfW - 4, rx));
      const left = labelX - halfW;
      const right = labelX + halfW;
      const hitsSnapshot = snapshotX !== null && left < snapRight + 10 && right > snapLeft - 10;
      const hitsUnit = left < axisUnitRight + 8;
      const nearTick = Math.abs(labelX - rx) <= 56;
      const crossesSnapshot = snapshotX !== null && rx > snapLeft - 4 && rx < snapRight + 4;
      return {
        ...reset,
        rx,
        text,
        halfW,
        labelX,
        left,
        right,
        hitsSnapshot,
        hitsUnit,
        nearTick,
        crossesSnapshot,
      };
    });
  let needsUpperRail = false;
  let probeRight = -Infinity;
  for (const reset of rawResets) {
    if (reset.hitsSnapshot || reset.hitsUnit || reset.left < probeRight + 14) {
      needsUpperRail = true;
      break;
    }
    probeRight = reset.right;
  }
  const placedRight = [-Infinity, -Infinity];
  const resetMarkers = rawResets.map((reset) => {
    const base: 0 | 1 = needsUpperRail ? 1 : 0;
    for (const lane of [base, (1 - base) as 0 | 1]) {
      const clear = reset.nearTick && (lane === 1 || (!reset.hitsSnapshot && !reset.hitsUnit));
      if (clear && reset.left >= placedRight[lane] + 14) {
        placedRight[lane] = reset.right;
        return { ...reset, lane };
      }
    }
    return { ...reset, lane: -1 as const };
  });
  const lowerLabels = resetMarkers.filter((reset) => reset.lane === 0);
  const crossesLowerLabel = (rx: number) =>
    lowerLabels.some((reset) => Math.abs(rx - reset.labelX) < reset.halfW - 5);
  const hasStaggeredReset = resetMarkers.some((reset) => reset.lane === 1);
  const staggerPad = hasStaggeredReset ? 18 : 0;
  const chartFrame = staggerPad
    ? {
        ...baseFrame,
        height: baseFrame.height + staggerPad,
        top: baseFrame.top + staggerPad,
        bottom: baseFrame.bottom + staggerPad,
      }
    : baseFrame;
  const geometry = chartGeometry(samples, mode, pool.capacityPoints, fromMs, toMs, chartFrame);
  const { x, y, min, max, segmentRuns } = geometry;
  const latestRecorded = samples.reduce(
    (latest, { point, projected }, index) => (!projected && point.atMs <= nowMs ? index : latest),
    0
  );
  const selected = Math.max(0, Math.min(inspected ?? latestRecorded, samples.length - 1));
  const sample = samples[Math.min(selected, samples.length - 1)];
  const hasValues = samples.some(({ point }) => point[field] !== null);
  const hasProjection = samples.some(({ point, projected }) => projected && point[field] !== null);
  const unobserved = sample ? sample.point[field] === null : true;
  const hasRecorded = samples.some(({ point, projected }) => !projected && point[field] !== null);
  const readingText = !sample
    ? ''
    : unobserved
      ? t(hasRecorded ? 'quota_pool.no_complete_reading_at' : 'quota_pool.no_reading_at', {
          date: date(sample.point.atMs),
        })
      : `${date(sample.point.atMs)} · ${number(sample.point[field])}\u00a0${unit}`;
  const latestPrefix = selected === latestRecorded ? `${t('quota_pool.latest_reading')} · ` : '';
  const valueOnCard =
    selected === latestRecorded &&
    !sample?.projected &&
    sample?.point[field] !== null &&
    sample?.point[field] === pool[field];
  const description = !sample
    ? t('quota_pool.inspect_hint')
    : unobserved
      ? readingText
      : valueOnCard
        ? `${latestPrefix}${date(sample.point.atMs)}`
        : `${latestPrefix}${readingText}${sample.projected ? ` · ${t('quota_pool.projected')}` : ''}`;

  const selectAtPointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const cursorX = ((event.clientX - bounds.left) / bounds.width) * chartFrame.width;
    let closest = 0;
    for (let index = 1; index < samples.length; index += 1) {
      if (
        Math.abs(x(samples[index].point.atMs) - cursorX) <=
        Math.abs(x(samples[closest].point.atMs) - cursorX)
      ) {
        closest = index;
      }
    }
    if (samples.length) setInspected(closest);
  };

  return (
    <div className={styles.chart} ref={container}>
      <svg
        viewBox={`0 0 ${chartFrame.width} ${chartFrame.height}`}
        role="img"
        aria-labelledby={`${id}-title ${id}-desc`}
        aria-describedby={`${id}-readout`}
        tabIndex={samples.length > 1 ? 0 : undefined}
        onPointerDown={selectAtPointer}
        onPointerMove={selectAtPointer}
        onKeyDown={(event) => {
          const last = samples.length - 1;
          const next =
            event.key === 'ArrowLeft'
              ? Math.max(0, selected - 1)
              : event.key === 'ArrowRight'
                ? Math.min(last, selected + 1)
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? last
                    : null;
          if (next === null || last < 1) return;
          event.preventDefault();
          setInspected(next);
        }}
      >
        <title id={`${id}-title`}>
          {t('quota_pool.chart_title', {
            provider: poolProviderLabel(t, pool.provider, pool.displayName),
            mode: t(`quota_pool.${mode}`),
          })}
        </title>
        <desc id={`${id}-desc`}>{t('quota_pool.chart_description')}</desc>
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--pool-accent)" stopOpacity=".19" />
            <stop offset="100%" stopColor="var(--pool-accent)" stopOpacity="0" />
          </linearGradient>
          <clipPath id={`${id}-clip`}>
            <rect
              x={chartFrame.left - 6}
              y={chartFrame.top - 6}
              width={chartFrame.right - chartFrame.left + 12}
              height={chartFrame.bottom - chartFrame.top + 12}
            />
          </clipPath>
        </defs>
        <text
          className={styles.axisUnit}
          x={alignUnitEnd ? chartFrame.left - 10 : 0}
          y={chartFrame.top - 16}
          textAnchor={alignUnitEnd ? 'end' : 'start'}
        >
          {unit}
        </text>
        {axisTicks(min, max).map((value, index) => (
          <g key={index} className={value === 0 && min < 0 ? styles.zeroAxis : styles.grid}>
            <line x1={chartFrame.left} x2={chartFrame.right} y1={y(value)} y2={y(value)} />
            <text x={chartFrame.left - 10} y={y(value) + 4} textAnchor="end">
              {number(value)}
            </text>
          </g>
        ))}
        {(hourly ? hourTicks : dayTicks)(fromMs, toMs, tickCount).map((at) => {
          const edge = 40;
          return (
            <g key={at} className={styles.grid}>
              <line x1={x(at)} x2={x(at)} y1={chartFrame.top} y2={chartFrame.bottom} />
              <text
                x={x(at)}
                y={chartFrame.bottom + 26}
                textAnchor={
                  x(at) - chartFrame.left < edge
                    ? 'start'
                    : chartFrame.right - x(at) < edge
                      ? 'end'
                      : 'middle'
                }
              >
                {formatPoolTick(at, i18n.language, hourly)}
              </text>
            </g>
          );
        })}
        <g clipPath={`url(#${id}-clip)`}>
          <g {...poolProviderStyle(pool.provider)} data-series={pool.instanceId ?? pool.provider}>
            <PoolTracePaths
              samples={samples}
              mode={mode}
              x={x}
              y={y}
              segmentRuns={segmentRuns}
              stroke="var(--pool-accent)"
              strokeWidth={2.4}
              fillId={`${id}-fill`}
              fillProjected
              sparseProjection={sparseProjection}
              keyPrefix="pool"
            />
          </g>
          {visible(nowMs) && (
            <line
              x1={x(nowMs)}
              x2={x(nowMs)}
              y1={chartFrame.top}
              y2={chartFrame.bottom}
              className={styles.nowLine}
            />
          )}
          {sample && sample.point[field] !== null && (
            <g {...poolProviderStyle(pool.provider)}>
              <line
                x1={x(sample.point.atMs)}
                x2={x(sample.point.atMs)}
                y1={chartFrame.top}
                y2={chartFrame.bottom}
                stroke="var(--pool-accent)"
                opacity=".5"
              />
              <circle
                cx={x(sample.point.atMs)}
                cy={y(sample.point[field]!)}
                r="5"
                fill="var(--pool-accent)"
                stroke="#111"
                strokeWidth="2"
              />
            </g>
          )}
          {mode === 'remaining' && visible(pool.poolEmptyAtMs) && (
            <circle
              {...poolProviderStyle(pool.provider)}
              cx={x(pool.poolEmptyAtMs)}
              cy={y(0)}
              r="5"
              fill="#111"
              stroke="var(--pool-accent)"
              strokeWidth="2"
            >
              <title>{`${t('quota_pool.pool_empty')}: ${date(pool.poolEmptyAtMs)}`}</title>
            </circle>
          )}
        </g>
        {snapshotX !== null && (
          <text
            className={styles.nowLabel}
            x={snapshotAnchor === 'end' ? snapshotX - 4 : snapshotX}
            y={chartFrame.top - 10}
            textAnchor={snapshotAnchor}
          >
            {snapshotText}
          </text>
        )}
        {mode === 'remaining' &&
          resetMarkers.map((reset, index) => {
            const rx = x(reset.atMs);
            const labelY = reset.lane === 1 ? chartFrame.top - 34 : chartFrame.top - 10;
            return (
              <g key={`${reset.atMs}-${index}`} className={styles.resetMarker}>
                <line
                  className={styles.resetGuide}
                  x1={rx}
                  x2={rx}
                  y1={chartFrame.top + 14}
                  y2={chartFrame.bottom}
                />
                {reset.lane === 1 && !reset.crossesSnapshot && !crossesLowerLabel(reset.rx) && (
                  <line
                    className={styles.resetLeader}
                    x1={rx}
                    x2={rx}
                    y1={chartFrame.top - 28}
                    y2={chartFrame.top}
                  />
                )}
                <line
                  x1={rx}
                  x2={rx}
                  y1={
                    reset.lane === 1 && reset.crossesSnapshot ? chartFrame.top - 3 : chartFrame.top
                  }
                  y2={chartFrame.top + 14}
                />
                {reset.lane >= 0 && (
                  <text x={reset.labelX} y={labelY} textAnchor="middle">
                    {reset.text}
                  </text>
                )}
                <title>{`${t('quota_pool.reset')}: ${date(reset.atMs)} · ${reset.text} ${unit}`}</title>
              </g>
            );
          })}
        {!hasValues && (
          <text
            x={(chartFrame.left + chartFrame.right) / 2}
            y={chartFrame.height / 2}
            textAnchor="middle"
            className={styles.emptyChart}
          >
            {t('quota_pool.no_history')}
          </text>
        )}
        {hasValues &&
          !hasProjection &&
          mode === 'remaining' &&
          pool.forecastState === 'ready' &&
          visible(nowMs) &&
          x(nowMs) < chartFrame.right - 130 && (
            <text
              x={(x(nowMs) + chartFrame.right) / 2}
              y={(chartFrame.top + chartFrame.bottom) / 2}
              textAnchor="middle"
              className={styles.emptyChart}
            >
              {t('quota_pool.projection_unavailable')}
            </text>
          )}
      </svg>
      <div className={styles.chartFooter}>
        <div className={styles.legend}>
          <span data-style-key>
            <i />
            {t('quota_pool.recorded')}
          </span>
          {hasProjection && (
            <span data-style-key>
              <i className={styles.dashed} />
              {t('quota_pool.projected')}
            </span>
          )}
          {mode === 'remaining' && resetMarkers.length > 0 && (
            <span>
              <i className={styles.resetKey} />
              {t('quota_pool.scheduled_reset')}
            </span>
          )}
        </div>
      </div>
      <div
        className={styles.inspectionRow}
        data-redundant={
          (inspected === null &&
            valueOnCard &&
            samples.length > 1 &&
            sample?.point.atMs === nowMs) ||
          undefined
        }
      >
        <div
          className={
            inspected === null && valueOnCard && samples.length > 1 && sample?.point.atMs === nowMs
              ? styles.srOnly
              : styles.chartReadout
          }
          id={`${id}-readout`}
          aria-live="polite"
        >
          {description}
          {samples.length === 1 && (
            <>
              {' · '}
              <span className={styles.nowrap}>{t('quota_pool.single_sample')}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
