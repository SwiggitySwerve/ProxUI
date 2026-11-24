import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PoolDashboard, QuotaPool, PoolTrace, PoolProviderId } from '@/domain/quotaPool/types';
import {
  chartFrame as defaultChartFrame,
  fitChartFrame,
  chartGeometry,
  chartSamples,
  stackSamples,
  bandSegments,
  dayTicks,
  hourTicks,
  inRange,
  viewRange,
  metricField,
  type ChartMode,
} from './chartGeometry';
import { formatPoolDate, formatPoolNumber, formatPoolTick } from './presentation';
import { poolProviderLabel, poolProviderStyle } from './providerPresentation';
import styles from './QuotaPoolPage.module.scss';

type ChartPool = PoolTrace & {
  provider: PoolProviderId | 'total';
  sourceLabel?: string;
  instanceId?: string;
  displayName?: string;
  /** A layer with history only: its zero projection aligns the stack and is not drawn. */
  historyOnly?: true;
};

interface ChartProps {
  dashboard: Pick<PoolDashboard, 'fromMs' | 'toMs' | 'nowMs' | 'window'>;
  mode: ChartMode;
  savedData?: boolean;
  minimized?: boolean;
  stackedTotal?: PoolTrace;
}

export function PoolChart({ pool, ...props }: ChartProps & { pool: QuotaPool }) {
  return <PoolChartView {...props} pools={[pool]} />;
}

export function PoolComparisonChart(props: ChartProps & { pools: ChartPool[] }) {
  return <PoolChartView {...props} comparison />;
}

function PoolChartView({
  pools,
  dashboard,
  mode,
  savedData = false,
  minimized = false,
  comparison = false,
  stackedTotal,
}: ChartProps & { pools: ChartPool[]; comparison?: boolean }) {
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
  const rawSeries = pools.map((pool) => {
    const samples = inRange(chartSamples(pool.recorded, pool.projected, mode), fromMs, toMs);
    return {
      pool,
      samples,
      sparseProjection: samples.filter((sample) => sample.projected).length < 3,
    };
  });
  const totalSamples = stackedTotal
    ? inRange(chartSamples(stackedTotal.recorded, stackedTotal.projected, mode), fromMs, toMs)
    : [];
  const stacked = stackedTotal
    ? stackSamples(
        rawSeries.map((series) => series.samples),
        totalSamples,
        mode
      )
    : undefined;
  const series = rawSeries.map((series, index) => {
    const samples = series.samples.map((sample, at) => {
      const position = stacked ? (stacked[index][at]?.upper ?? null) : sample.point[field];
      return {
        ...sample,
        position,
        base: stacked?.[index][at]?.lower ?? 0,
        point: stacked && position === null ? { ...sample.point, [field]: null } : sample.point,
      };
    });
    return {
      ...series,
      samples,
      plotSamples: samples.map((sample) => ({
        ...sample,
        point: { ...sample.point, [field]: sample.position },
      })),
      band: stacked?.[index],
    };
  });
  // A history-only layer's forecast zeros only align the stack: nothing to inspect or mark.
  const samples = series.flatMap(({ pool, samples }) =>
    samples
      .filter((sample) => !(pool.historyOnly && sample.projected))
      .map((sample) => ({ ...sample, pool }))
  );
  // The y axis labels min, middle and max (below). Its gutter is as wide as the widest of them, and
  // never narrower than the capacity it was sized from before, so a chart whose data stays inside
  // capacity keeps its layout. A retired pool (no capacity) or a stack topped by retired history
  // labels its data instead, and those labels must not clip.
  const axisCapacity =
    stackedTotal?.capacityPoints ?? Math.max(0, ...pools.map((pool) => pool.capacityPoints));
  const axisSamples = stacked
    ? stacked.flatMap((layer) =>
        layer.flatMap((sample) =>
          [sample.lower, sample.upper].map((value) => ({
            ...sample,
            point: { ...sample.point, [field]: value },
          }))
        )
      )
    : samples;
  const axis = chartGeometry(axisSamples, mode, axisCapacity, fromMs, toMs);
  const numberChars = Math.max(
    ...[
      Math.max(0, stackedTotal?.capacityPoints ?? 0, ...pools.map((pool) => pool.capacityPoints)),
      ...(axis.min === axis.max ? [axis.min] : [axis.min, (axis.min + axis.max) / 2, axis.max]),
    ].map((value) => formatPoolNumber(value, i18n.language).length)
  );
  const alignUnitEnd = width >= 600;
  const baseFrame = fitChartFrame(
    width,
    savedData || pools.some((pool) => pool.forecastState !== 'ready') || mode !== 'remaining',
    // One reading draws a point, not a line, so it gets the compact height.
    minimized || Math.max(...pools.map((pool) => pool.recorded.length)) === 1,
    alignUnitEnd ? Math.max(numberChars, Math.ceil(unit.length * 0.72)) : numberChars
  );
  // Order inspection by time without joining or resampling separate source traces.
  if (comparison) samples.sort((a, b) => a.point.atMs - b.point.atMs);
  // The source only tells series apart when one provider has several; otherwise it is noise.
  const sharesProvider = (pool: ChartPool) =>
    pools.filter((other) => other.provider === pool.provider).length > 1;
  const poolLabel = (pool: ChartPool) =>
    `${poolProviderLabel(t, pool.provider, pool.displayName)}${(pool.sourceLabel || pool.instanceId) && sharesProvider(pool) ? ` · ${pool.sourceLabel ?? pool.instanceId}` : ''}`;
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
    (comparison || mode !== 'remaining' ? [] : pools).some((pool) =>
      pool.resets.some((reset) => {
        if (!visible(reset.atMs) || reset.gainPoints <= 0) return false;
        const gap = projectX(reset.atMs) - snapshotX;
        return gap >= 0 && gap < snapW / 2 + 40;
      })
    );
  const snapshotAnchor =
    snapshotX === null
      ? 'middle'
      : baseFrame.right - snapshotX < 60 ||
          (resetJustAfter && snapshotX - baseFrame.left >= snapW)
        ? 'end'
        : snapshotX - baseFrame.left < 60
          ? 'start'
          : 'middle';
  // Place scheduled reset labels on the primary annotation baseline when all clear Snapshot and
  // siblings; if any collides, elevate all reset labels in that chart onto one uniform upper rail
  // so reset amounts stay level with each other and well clear of Snapshot.
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
  const rawResets = (comparison || mode !== 'remaining' ? [] : pools)
    .flatMap((pool) => pool.resets)
    .filter((reset) => visible(reset.atMs) && reset.gainPoints > 0)
    .map((reset) => {
      const rx = projectX(reset.atMs);
      const text = `+${number(reset.gainPoints)}`;
      const halfW = text.length * 4.5 + 7;
      // On either lane a label centres on its tick, kept inside the chart's edges.
      const labelX = Math.max(halfW + 4, Math.min(baseFrame.width - halfW - 4, rx));
      const left = labelX - halfW;
      const right = labelX + halfW;
      const hitsSnapshot = snapshotX !== null && left < snapRight + 10 && right > snapLeft - 10;
      const hitsUnit = left < axisUnitRight + 8;
      const nearTick = Math.abs(labelX - rx) <= 56;
      const crossesSnapshot = snapshotX !== null && rx > snapLeft - 4 && rx < snapRight + 4;
      return { ...reset, rx, text, halfW, labelX, left, right, hitsSnapshot, hitsUnit, nearTick, crossesSnapshot };
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
  // Every scheduled reset keeps its tick (G10). Its label takes the chart's lane (the upper lane when
  // any label would hit Snapshot), else the other lane, and is left off only when neither has room.
  const placedRight = [-Infinity, -Infinity];
  const resetMarkers = rawResets.map((reset) => {
    const base: 0 | 1 = needsUpperRail ? 1 : 0;
    for (const lane of [base, (1 - base) as 0 | 1]) {
      // The upper lane sits above Snapshot, so only the chart's own lane checks for it.
      const clear = reset.nearTick && (lane === 1 || (!reset.hitsSnapshot && !reset.hitsUnit));
      if (clear && reset.left >= placedRight[lane] + 14) {
        placedRight[lane] = reset.right;
        return { ...reset, lane };
      }
    }
    return { ...reset, lane: -1 as const };
  });
  // An upper label's leader runs down through the lower lane, so it is left off where it would cross
  // Snapshot's label or another reset's text (halfW less the 7px it keeps around the text, plus 2px).
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
  const geometry = chartGeometry(axisSamples, mode, axisCapacity, fromMs, toMs, chartFrame);
  const { x, y, min, max, segments } = geometry;
  const latestRecorded = samples.reduce(
    (latest, { point, projected }, index) => (!projected && point.atMs <= nowMs ? index : latest),
    0
  );
  const selected = Math.max(0, Math.min(inspected ?? latestRecorded, samples.length - 1));
  const sample = samples[Math.min(selected, samples.length - 1)];
  const hasValues = samples.some(({ point }) => point[field] !== null);
  const hasProjection = samples.some(({ point, projected }) => projected && point[field] !== null);
  // On a combined chart, state every provider's value at the selected moment, not one of them.
  const readingAt = sample
    ? comparison
      ? samples
          .filter(
            (other) =>
              other.point.atMs === sample.point.atMs && other.projected === sample.projected
          )
          .filter(
            (other, index, all) =>
              all.findIndex((first) => poolLabel(first.pool) === poolLabel(other.pool)) === index
          )
      : [sample]
    : [];
  // Values keep their unit on the same line (\u00a0) when the readout wraps.
  const readingValue = (other: (typeof samples)[number]) =>
    other.point[field] === null ? t('quota_pool.no_observation') : number(other.point[field]);
  // A moment with no value is not a recording: say so once, without a Recorded/Projected tag.
  const unobserved = readingAt.every((other) => other.point[field] === null);
  // Where the chart does draw recorded readings, a moment without one is missing only the complete set.
  const hasRecorded = samples.some(({ point, projected }) => !projected && point[field] !== null);
  const readingText = !sample
    ? ''
    : unobserved
      ? t(hasRecorded ? 'quota_pool.no_complete_reading_at' : 'quota_pool.no_reading_at', {
          date: date(sample.point.atMs),
        })
      : readingAt.length > 1
        ? `${readingAt.map((other) => `${poolLabel(other.pool)}: ${readingValue(other)}`).join(' · ')}${readingAt.some((other) => other.point[field] !== null) ? `\u00a0${unit}` : ''}`
        : `${comparison ? `${poolLabel(sample.pool)} · ` : ''}${date(sample.point.atMs)} · ${sample.point[field] === null ? t('quota_pool.no_observation') : `${number(sample.point[field])}\u00a0${unit}`}`;
  const latestPrefix = selected === latestRecorded ? `${t('quota_pool.latest_reading')} · ` : '';
  // When a single-provider chart's latest recorded value is the card's big number, the readout
  // names only its moment; a withheld total or any other point shows values. A combined chart's
  // latest reading names only its moment too: the provider cards show each value.
  const valueOnCard =
    selected === latestRecorded &&
    !sample?.projected &&
    (comparison
      ? !unobserved
      : sample?.point[field] !== null && sample?.point[field] === sample?.pool[field]);
  const description = !sample
    ? t('quota_pool.inspect_hint')
    : unobserved
      ? readingText
      : valueOnCard
        ? `${latestPrefix}${date(sample.point.atMs)}`
        : `${latestPrefix}${readingAt.length > 1 ? `${date(sample.point.atMs)} · ` : ''}${readingText}${sample.projected ? ` · ${t('quota_pool.projected')}` : ''}`;

  const selectAtPointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const cursorX = ((event.clientX - bounds.left) / bounds.width) * chartFrame.width;
    const cursorY = ((event.clientY - bounds.top) / bounds.height) * chartFrame.height;
    const distance = (index: number) => {
      const { point, position, base } = samples[index];
      const dx = Math.abs(x(point.atMs) - cursorX);
      // On an overlay, equal timestamps must still allow either provider to be inspected.
      if (stackedTotal && position !== null) {
        const top = Math.min(y(position), y(base));
        const bottom = Math.max(y(position), y(base));
        return Math.hypot(dx, Math.max(top - cursorY, 0, cursorY - bottom));
      }
      return comparison && position !== null ? Math.hypot(dx, y(position) - cursorY) : dx;
    };
    let closest = 0;
    for (let index = 1; index < samples.length; index += 1) {
      if (distance(index) <= distance(closest)) closest = index;
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
            provider: comparison
              ? t('quota_pool.combined_usage')
              : poolProviderLabel(t, pools[0].provider, pools[0].displayName),
            mode: t(`quota_pool.${mode}`),
          })}
        </title>
        <desc id={`${id}-desc`}>
          {t(
            stackedTotal
              ? mode === 'remaining'
                ? 'quota_pool.stacked_description'
                : 'quota_pool.stacked_rate_description'
              : comparison
                ? 'quota_pool.combined_description'
                : 'quota_pool.chart_description'
          )}
        </desc>
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
        {(min === max ? [min] : [min, (min + max) / 2, max]).map((value, index) => (
          <g key={index} className={styles.grid}>
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
          {series.map(
            (
              { pool, samples: seriesSamples, plotSamples, band, sparseProjection },
              seriesIndex
            ) => (
              <g
                key={seriesIndex}
                {...poolProviderStyle(pool.provider)}
                data-series={pool.instanceId ?? pool.provider}
              >
                {band &&
                  (pool.historyOnly ? [false] : [false, true]).flatMap((projected) =>
                    bandSegments(band, projected, x, y).map((path, index) => (
                      <path
                        key={`band-${projected}-${index}`}
                        data-stack-band={projected ? 'projected' : 'recorded'}
                        d={path}
                        fill="var(--pool-accent)"
                        // Rates don't accumulate, so their bands stay light and the lines lead.
                        fillOpacity={
                          mode === 'remaining' ? (projected ? 0.14 : 0.3) : projected ? 0.1 : 0.22
                        }
                      />
                    ))
                  )}
                {(pool.historyOnly ? [false] : [false, true]).map((projected) =>
                  segments(projected, plotSamples).map((path, index) => {
                    const firstX = path.slice(1).split(',')[0];
                    const lastX = path.split(' L').slice(-1)[0]?.replace(/^M/, '').split(',')[0];
                    return (
                      <g key={`${projected}-${index}`}>
                        {mode === 'remaining' && !comparison && (
                          <path
                            d={`${path} L${lastX},${y(0)} L${firstX},${y(0)} Z`}
                            fill={`url(#${id}-fill)`}
                          />
                        )}
                        <path
                          d={path}
                          fill="none"
                          stroke="var(--pool-accent)"
                          strokeWidth="2.4"
                          strokeDasharray={projected ? '7 5' : undefined}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </g>
                    );
                  })
                )}
                {seriesSamples.map(({ point, projected, position }, index) =>
                  position === null ||
                  (projected && (!sparseProjection || pool.historyOnly)) ? null : (
                    <circle
                      key={index}
                      cx={x(point.atMs)}
                      cy={y(position!)}
                      r={seriesSamples.length < 3 ? 3 : 1.5}
                      fill="var(--pool-accent)"
                      opacity={projected ? 0.6 : 1}
                    />
                  )
                )}
              </g>
            )
          )}
          {visible(nowMs) && (
            <line
              x1={x(nowMs)}
              x2={x(nowMs)}
              y1={chartFrame.top}
              y2={chartFrame.bottom}
              className={styles.nowLine}
            />
          )}
          {sample && sample.position !== null && (
            <g {...poolProviderStyle(sample.pool.provider)}>
              <line
                x1={x(sample.point.atMs)}
                x2={x(sample.point.atMs)}
                y1={chartFrame.top}
                y2={chartFrame.bottom}
                // On a combined chart the rule marks a moment, not a provider: keep it neutral.
                stroke={comparison ? 'var(--text-tertiary)' : 'var(--pool-accent)'}
                opacity=".5"
              />
              {/* A dot on every series the readout names, not only the one nearest the pointer. */}
              {readingAt.map(
                (other, index) =>
                  other.position !== null && (
                    <circle
                      key={index}
                      {...poolProviderStyle(other.pool.provider)}
                      cx={x(other.point.atMs)}
                      cy={y(other.position)}
                      r="5"
                      fill="var(--pool-accent)"
                      stroke="#111"
                      strokeWidth="2"
                    />
                  )
              )}
            </g>
          )}
          {mode === 'remaining' &&
            !stackedTotal &&
            pools.map(
              (pool, index) =>
                visible(pool.poolEmptyAtMs) && (
                  <circle
                    key={index}
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
                )
            )}
        </g>
        {snapshotX !== null && (
          <text
            className={styles.nowLabel}
            x={snapshotAnchor === 'end' ? snapshotX - 4 : snapshotX}
            y={chartFrame.top - 10}
            // Near an edge (rate views end at the snapshot) the label turns inward with a 4px inset.
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
                  y1={reset.lane === 1 && reset.crossesSnapshot ? chartFrame.top - 3 : chartFrame.top}
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
        {/* The card's status chip and strip already explain degraded forecasts, and the page note
            explains rate views; only a ready pool with no projection needs saying here. */}
        {hasValues &&
          !hasProjection &&
          mode === 'remaining' &&
          pools.every((pool) => pool.forecastState === 'ready') &&
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
          {comparison &&
            pools.map((pool, index) => (
              <span
                key={index}
                {...poolProviderStyle(pool.provider)}
                data-stacked-swatch={stackedTotal ? '' : undefined}
              >
                <i />
                {poolLabel(pool)}
                {/* A retired layer is history by design, not a partial forecast. */}
                {pool.historyOnly
                  ? ` · ${t('quota_pool.history_only')}`
                  : pool.forecastState !== 'ready' &&
                    ` · ${t(`quota_pool.state.${pool.forecastState}`)}`}
              </span>
            ))}
          {/* Line styles are a separate key from provider colours, so they read as styles. */}
          <span data-style-key data-divider={comparison || undefined}>
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
      {/* At rest on healthy multi-sample cards whose latest reading matches the page timestamp,
          Data collection already states that time once; keep the readout in the DOM for assistive
          tech and reveal it visually when inspecting a point, collecting, or missing a reading. */}
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
