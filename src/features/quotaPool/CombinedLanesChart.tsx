import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PoolDashboard, PoolTrace } from '@/domain/quotaPool/types';
import {
  axisTicks,
  chartFrame as defaultChartFrame,
  chartGeometry,
  chartSamples,
  dayTicks,
  hourTicks,
  inRange,
  metricField,
  viewRange,
  type ChartMode,
} from './chartGeometry';
import {
  buildLaneStops,
  computeLanesLayout,
  findNextReset,
  latestRecordedStopIndex,
  placeLaneResets,
  placeTotalResetTicks,
  sameVisibleTrace,
  type LaneStop,
  type LaneTrace,
} from './combinedLanesModel';
import { PoolTracePaths } from './PoolTracePaths';
import { formatPoolDate, formatPoolNumber, formatPoolTick } from './presentation';
import {
  poolProviderLabel,
  poolProviderStyle,
  providerGlyphPath,
  providerMarkerShape,
} from './providerPresentation';
import { useChartScrub } from './useChartScrub';
import styles from './QuotaPoolPage.module.scss';

const DEFAULT_VISIBLE_LANES = 3;
const MAX_INLINE_RESET_PILLS = 2;

export function CombinedLanesChart({
  lanes,
  totalSeries,
  dashboard,
  mode,
  savedData = false,
  minimized = false,
}: {
  lanes: LaneTrace[];
  totalSeries?: PoolTrace;
  dashboard: Pick<PoolDashboard, 'fromMs' | 'toMs' | 'nowMs' | 'window'>;
  mode: ChartMode;
  savedData?: boolean;
  minimized?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(defaultChartFrame.width);
  const [showAllLanes, setShowAllLanes] = useState(false);

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
  const narrow = width < 600;
  const tickCount = width < 480 ? 4 : width < 850 ? 5 : 8;
  const { fromMs, toMs } = viewRange(dashboard, mode);
  const { nowMs } = dashboard;
  const hourly = toMs - fromMs <= 2.5 * 86_400_000;
  const field = metricField[mode];

  const sharesProvider = (lane: LaneTrace) =>
    lanes.filter((other) => other.provider === lane.provider).length > 1;
  const laneLabel = (lane: LaneTrace) =>
    `${poolProviderLabel(t, lane.provider, lane.displayName)}${(lane.sourceLabel || lane.instanceId) && sharesProvider(lane) ? ` · ${lane.sourceLabel ?? lane.instanceId}` : ''}`;
  const number = (value: number | null) => formatPoolNumber(value, i18n.language);
  const date = (value: number) => formatPoolDate(value, i18n.language);
  const visible = (at: number | null): at is number => at !== null && at >= fromMs && at <= toMs;

  const totalSamples = totalSeries
    ? inRange(chartSamples(totalSeries.recorded, totalSeries.projected, mode), fromMs, toMs)
    : [];
  const laneSampleSets = lanes.map((lane) => {
    const samples = inRange(chartSamples(lane.recorded, lane.projected, mode), fromMs, toMs);
    return {
      lane,
      samples,
      visibleSamples: lane.historyOnly ? samples.filter((s) => !s.projected) : samples,
      sparseProjection:
        !lane.historyOnly && samples.filter((sample) => sample.projected).length < 3,
    };
  });

  // Always render the neutral server Total when supplied. Suppress a sole lane below it only when
  // Total actually draws the same visible trace (e.g. an empty failed-inventory Total still keeps
  // the sole provider's recorded history visible in its lane).
  const hasTotal = Boolean(totalSeries);
  const skipDuplicateLane =
    hasTotal &&
    lanes.length === 1 &&
    sameVisibleTrace(totalSamples, laneSampleSets[0].visibleSamples, mode);
  const singleStandaloneLane = !hasTotal && lanes.length === 1;
  const collapsedCount =
    !skipDuplicateLane && !minimized && !showAllLanes && lanes.length > DEFAULT_VISIBLE_LANES
      ? lanes.length - DEFAULT_VISIBLE_LANES
      : 0;
  const visibleLaneSets =
    (minimized && hasTotal) || skipDuplicateLane
      ? []
      : collapsedCount > 0
        ? laneSampleSets.slice(0, DEFAULT_VISIBLE_LANES)
        : laneSampleSets;

  // Measure widest Y-axis tick across Total and every rendered lane so the gutter never clips.
  const tickCandidates: number[] = [];
  if (totalSeries && hasTotal) {
    const totalAxis = chartGeometry(totalSamples, mode, totalSeries.capacityPoints, fromMs, toMs);
    tickCandidates.push(totalSeries.capacityPoints, ...axisTicks(totalAxis.min, totalAxis.max));
  }
  for (const { lane, visibleSamples } of visibleLaneSets) {
    const laneAxis = chartGeometry(visibleSamples, mode, lane.capacityPoints, fromMs, toMs);
    tickCandidates.push(lane.capacityPoints, ...axisTicks(laneAxis.min, laneAxis.max));
  }
  const numberChars = Math.max(1, ...tickCandidates.map((v) => number(v).length));
  const alignUnitEnd = width >= 600;
  const labelChars = alignUnitEnd
    ? Math.max(numberChars, Math.ceil(unit.length * 0.72))
    : numberChars;

  const layout = computeLanesLayout({
    width,
    minimized,
    hasTotal,
    visibleLaneCount: visibleLaneSets.length,
    labelChars,
  });

  const x = (atMs: number) =>
    layout.left + ((atMs - fromMs) / Math.max(1, toMs - fromMs)) * (layout.right - layout.left);

  const stops = buildLaneStops({
    totalSamples,
    laneSamples: laneSampleSets.map((s) => s.samples),
    lanes,
    mode,
    fromMs,
    toMs,
    labelOf: laneLabel,
  });
  const latestIdx = latestRecordedStopIndex(stops, nowMs);
  const scrub = useChartScrub({
    stops,
    latestIdx,
    fromMs,
    toMs,
    layoutWidth: layout.width,
    x,
  });
  const activeStop = stops[scrub.activeIndex];
  const committedStop = stops[scrub.committedIndex];
  const { isInspecting, showNowButton } = scrub;

  const hasValues =
    Boolean(layout.totalBox && totalSamples.some((s) => s.point[field] !== null)) ||
    visibleLaneSets.some((set) => set.visibleSamples.some((s) => s.point[field] !== null));
  const hasProjection =
    Boolean(
      layout.totalBox &&
      totalSeries &&
      totalSamples.some((s) => s.projected && s.point[field] !== null)
    ) ||
    visibleLaneSets.some((set) =>
      set.visibleSamples.some((s) => s.projected && s.point[field] !== null)
    );

  const totalGeom =
    totalSeries && layout.totalBox
      ? chartGeometry(totalSamples, mode, totalSeries.capacityPoints, fromMs, toMs, layout.totalBox)
      : null;
  const laneGeoms = visibleLaneSets.map(({ lane, visibleSamples }, index) =>
    chartGeometry(visibleSamples, mode, lane.capacityPoints, fromMs, toMs, layout.laneBoxes[index])
  );

  const totalTicks =
    mode === 'remaining' && layout.totalBox
      ? placeTotalResetTicks(lanes, fromMs, toMs, x, laneLabel)
      : [];
  const laneResetSets = visibleLaneSets.map(({ lane }, index) =>
    mode === 'remaining' && !lane.historyOnly
      ? placeLaneResets(
          lane.resets,
          fromMs,
          toMs,
          x,
          layout.laneBoxes[index].right,
          i18n.language,
          narrow
        )
      : []
  );
  const hasAnyReset =
    totalTicks.length > 0 || laneResetSets.some((resetList) => resetList.length > 0);
  const showTickLegend =
    hasTotal && (minimized || skipDuplicateLane) && mode === 'remaining' && totalTicks.length > 0;
  const nextReset = mode === 'remaining' ? findNextReset(lanes, nowMs, toMs, laneLabel) : null;

  // All scheduled resets across all active lanes, for assistive tech.
  const allScheduledResets =
    mode === 'remaining'
      ? lanes
          .flatMap((lane) =>
            lane.historyOnly
              ? []
              : lane.resets
                  .filter((r) => visible(r.atMs) && r.gainPoints > 0)
                  .map((r) => ({
                    atMs: r.atMs,
                    gainPoints: r.gainPoints,
                    provider: lane.provider,
                    label: laneLabel(lane),
                  }))
          )
          .sort((a, b) => a.atMs - b.atMs)
      : [];

  const snapshotText = t(`quota_pool.${savedData ? 'saved_snapshot' : 'snapshot'}`);
  const snapshotX = visible(nowMs) ? x(nowMs) : null;
  const snapshotAnchor =
    snapshotX === null
      ? 'middle'
      : layout.right - snapshotX < 64
        ? 'end'
        : snapshotX - layout.left < 64
          ? 'start'
          : 'middle';

  const topPlotY = layout.totalBox?.top ?? layout.laneBoxes[0]?.top ?? 36;
  const bottomPlotY =
    layout.laneBoxes[layout.laneBoxes.length - 1]?.bottom ?? layout.totalBox?.bottom ?? 126;

  // Build assistive-tech summary for the committed stop (never floods aria-live on hover).
  const describeStop = (stop: LaneStop | undefined, isLatest: boolean): string => {
    if (!stop) return t('quota_pool.inspect_hint');
    const parts: string[] = [];
    parts.push(
      isLatest && !stop.projected
        ? `${t('quota_pool.latest_reading')} · ${date(stop.atMs)}`
        : `${date(stop.atMs)}${stop.projected ? ` · ${t('quota_pool.projected')}` : ''}`
    );
    if (totalSeries && stop.totalAfter !== null) {
      parts.push(`${t('quota_pool.total')}: ${number(stop.totalAfter)}\u00a0${unit}`);
    }
    lanes.forEach((lane, index) => {
      if (lane.historyOnly && stop.projected) return;
      const val = stop.lanes[index];
      if (!val?.present) return;
      const reset = stop.resets.find((r) => r.laneIndex === index);
      if (reset) {
        parts.push(
          `${laneLabel(lane)}: ${number(val.after)}\u00a0${unit} (+${number(reset.gainPoints)})`
        );
      } else {
        parts.push(
          `${laneLabel(lane)}: ${val.after === null ? t('quota_pool.no_observation') : `${number(val.after)}\u00a0${unit}`}`
        );
      }
    });
    return parts.join(' · ');
  };

  const totalSparseProjection =
    totalSeries !== undefined && totalSamples.filter((s) => s.projected).length < 3;
  const activeX = isInspecting && activeStop ? x(activeStop.atMs) : null;
  const inlineResets =
    isInspecting && activeStop ? activeStop.resets.slice(0, MAX_INLINE_RESET_PILLS) : [];
  const hiddenResetCount =
    isInspecting && activeStop ? Math.max(0, activeStop.resets.length - inlineResets.length) : 0;
  const hiddenResetTitle =
    hiddenResetCount > 0 && activeStop
      ? activeStop.resets
          .slice(MAX_INLINE_RESET_PILLS)
          .map((reset) => `${reset.label} +${number(reset.gainPoints)}`)
          .join(', ')
      : undefined;
  const tickProviders = new Set(totalTicks.map((tick) => tick.provider));

  return (
    <div className={styles.chart} ref={container}>
      {/* Thumb-safe readout bar above the plot: fixed height so pinning never shifts the SVG. */}
      <div className={styles.lanesReadout}>
        <div className={styles.lanesReadoutMain}>
          {activeStop ? (
            <>
              <span className={styles.lanesReadoutTime}>
                {!isInspecting && !activeStop.projected
                  ? `${t('quota_pool.latest_reading')} · ${date(activeStop.atMs)}`
                  : date(activeStop.atMs)}
              </span>
              {activeStop.projected && (
                <span className={styles.lanesReadoutMeta}>{t('quota_pool.projected')}</span>
              )}
              {isInspecting && totalSeries && activeStop.totalAfter !== null && (
                <span className={styles.lanesReadoutTotal}>
                  {t('quota_pool.total')}{' '}
                  <strong>
                    {number(activeStop.totalAfter)}
                    {mode === 'remaining'
                      ? ` / ${number(totalSeries.capacityPoints)}`
                      : `\u00a0${unit}`}
                  </strong>
                </span>
              )}
              {inlineResets.length > 0 && (
                <span className={styles.lanesResetPills}>
                  {inlineResets.map((reset) => (
                    <span
                      key={`${reset.laneIndex}-${reset.atMs}`}
                      className={styles.lanesResetPill}
                      {...poolProviderStyle(reset.provider)}
                    >
                      {reset.label} +{number(reset.gainPoints)}
                    </span>
                  ))}
                  {hiddenResetCount > 0 && (
                    <span className={styles.lanesResetMore} title={hiddenResetTitle}>
                      +{hiddenResetCount}
                    </span>
                  )}
                </span>
              )}
              {!isInspecting && nextReset && (
                <span className={styles.lanesNextReset}>
                  {t('quota_pool.next_reset_summary', {
                    details: nextReset.items
                      .map((item) => `${item.label} +${number(item.gainPoints)}`)
                      .join(', '),
                    date: date(nextReset.atMs),
                  })}
                </span>
              )}
            </>
          ) : (
            <span className={styles.lanesReadoutMeta}>{t('quota_pool.inspect_hint')}</span>
          )}
        </div>
        <button
          type="button"
          className={
            showNowButton
              ? styles.lanesNowButton
              : `${styles.lanesNowButton} ${styles.lanesNowHidden}`
          }
          aria-hidden={!showNowButton || undefined}
          tabIndex={showNowButton ? 0 : -1}
          onClick={scrub.clearSelection}
        >
          {t('quota_pool.reset_now')}
        </button>
      </div>

      <svg
        className={styles.lanesChart}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-labelledby={`${id}-title ${id}-desc`}
        aria-describedby={`${id}-readout`}
        tabIndex={stops.length > 1 ? 0 : undefined}
        {...scrub.svgHandlers}
      >
        <title id={`${id}-title`}>
          {t('quota_pool.chart_title', {
            provider: singleStandaloneLane ? laneLabel(lanes[0]) : t('quota_pool.combined_usage'),
            mode: t(`quota_pool.${mode}`),
          })}
        </title>
        <desc id={`${id}-desc`}>
          {t(
            mode === 'remaining'
              ? 'quota_pool.combined_lanes_description'
              : 'quota_pool.combined_lanes_rate_description'
          )}
        </desc>
        <defs>
          <linearGradient id={`${id}-total-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--text-primary)" stopOpacity="0.14" />
            <stop offset="100%" stopColor="var(--text-primary)" stopOpacity="0" />
          </linearGradient>
          {visibleLaneSets.map(({ lane }, index) => (
            <linearGradient
              key={`grad-${index}`}
              id={`${id}-lane-fill-${index}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
              {...poolProviderStyle(lane.provider)}
            >
              <stop offset="0%" stopColor="var(--pool-accent)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="var(--pool-accent)" stopOpacity="0" />
            </linearGradient>
          ))}
          <clipPath id={`${id}-clip`}>
            <rect
              x={layout.left - 6}
              y={topPlotY - 8}
              width={layout.right - layout.left + 12}
              height={Math.max(1, bottomPlotY - topPlotY + 16)}
            />
          </clipPath>
        </defs>

        <text
          className={styles.axisUnit}
          x={alignUnitEnd ? layout.left - 10 : 0}
          y={topPlotY - 16}
          textAnchor={alignUnitEnd ? 'end' : 'start'}
        >
          {unit}
        </text>

        {/* Shared vertical date/hour gridlines spanning Total and every lane. */}
        {(hourly ? hourTicks : dayTicks)(fromMs, toMs, tickCount).map((at) => {
          const edge = 40;
          return (
            <g key={at} className={styles.grid}>
              <line x1={x(at)} x2={x(at)} y1={topPlotY} y2={bottomPlotY} />
              <text
                x={x(at)}
                y={layout.axisY}
                textAnchor={
                  x(at) - layout.left < edge
                    ? 'start'
                    : layout.right - x(at) < edge
                      ? 'end'
                      : 'middle'
                }
              >
                {formatPoolTick(at, i18n.language, hourly)}
              </text>
            </g>
          );
        })}

        {/* Total plot Y-axis gridlines & labels. */}
        {totalGeom &&
          layout.totalBox &&
          axisTicks(totalGeom.min, totalGeom.max).map((value, index) => (
            <g
              key={`total-y-${index}`}
              className={value === 0 && totalGeom.min < 0 ? styles.zeroAxis : styles.grid}
            >
              <line
                x1={layout.totalBox!.left}
                x2={layout.totalBox!.right}
                y1={totalGeom.y(value)}
                y2={totalGeom.y(value)}
              />
              <text x={layout.totalBox!.left - 10} y={totalGeom.y(value) + 4} textAnchor="end">
                {number(value)}
              </text>
            </g>
          ))}

        {/* Provider lane headers, baselines, and own-scale Y-axis gutter labels. */}
        {visibleLaneSets.map(({ lane }, index) => {
          const box = layout.laneBoxes[index];
          const geom = laneGeoms[index];
          const laneTicks = singleStandaloneLane
            ? axisTicks(geom.min, geom.max)
            : geom.min < 0 && geom.max > 0
              ? [geom.min, 0, geom.max]
              : geom.min === geom.max
                ? [geom.max]
                : [geom.min, geom.max];
          const stopVal = activeStop?.lanes[index];
          const resetHere = activeStop?.resets.find((r) => r.laneIndex === index);
          const shape = providerMarkerShape(lane.provider);
          const fullName = laneLabel(lane);
          const shownName = narrow && fullName.length > 18 ? `${fullName.slice(0, 17)}…` : fullName;
          const statusTag = lane.historyOnly
            ? t('quota_pool.history_only')
            : lane.forecastState !== 'ready'
              ? t(`quota_pool.state.${lane.forecastState}`)
              : null;
          const captionValue =
            lane.historyOnly && activeStop?.projected
              ? '—'
              : resetHere && resetHere.before !== null && resetHere.after !== null
                ? narrow
                  ? `${number(resetHere.after)} (+${number(resetHere.gainPoints)})`
                  : `${number(resetHere.before)} → ${number(resetHere.after)} (+${number(resetHere.gainPoints)})`
                : stopVal && stopVal.present
                  ? stopVal.after === null
                    ? t('quota_pool.no_observation')
                    : mode === 'remaining' && lane.capacityPoints > 0
                      ? `${number(stopVal.after)} / ${number(lane.capacityPoints)}`
                      : `${number(stopVal.after)}\u00a0${unit}`
                  : '';
          const zeroY = geom.min < 0 && geom.max > 0 ? geom.y(0) : null;

          return (
            <g
              key={`lane-chrome-${index}`}
              data-lane-header={lane.instanceId ?? lane.provider}
              {...poolProviderStyle(lane.provider)}
            >
              {!singleStandaloneLane && (
                <>
                  <path
                    d={providerGlyphPath(shape, layout.left + 4.5, box.captionY - 3.5, 4)}
                    fill="var(--pool-accent)"
                  />
                  <text x={layout.left + 14} y={box.captionY} className={styles.laneName}>
                    <title>{fullName}</title>
                    {shownName}
                    {statusTag && <tspan className={styles.laneStatus}>{` · ${statusTag}`}</tspan>}
                  </text>
                  {captionValue && (
                    <text
                      x={layout.right}
                      y={box.captionY}
                      textAnchor="end"
                      className={resetHere ? styles.laneValueReset : styles.laneValue}
                    >
                      {captionValue}
                    </text>
                  )}
                </>
              )}
              {laneTicks.map((value, tickIdx) => {
                const tickY = geom.y(value);
                // In compact signed lanes, always keep the "0" baseline label and drop a cramped
                // bound label if it would collide vertically with zero.
                const hideCrampedBound =
                  !singleStandaloneLane &&
                  zeroY !== null &&
                  ((value === geom.max && zeroY - tickY < 14) ||
                    (value === geom.min && tickY - zeroY < 14));
                const textY =
                  !singleStandaloneLane && value === geom.max
                    ? tickY + 8
                    : !singleStandaloneLane && value === geom.min
                      ? tickY
                      : Math.max(box.top + 8, Math.min(box.bottom, tickY + 4));
                return (
                  <g
                    key={`lane-y-${index}-${tickIdx}`}
                    className={value === 0 && geom.min < 0 ? styles.zeroAxis : styles.grid}
                  >
                    <line x1={box.left} x2={box.right} y1={tickY} y2={tickY} />
                    {!hideCrampedBound && (
                      <text x={box.left - 10} y={textY} textAnchor="end">
                        {number(value)}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* Clipped data paths: Total line + independent own-scale provider lane lines. */}
        <g clipPath={`url(#${id}-clip)`}>
          {totalSeries && totalGeom && layout.totalBox && (
            <g data-series="total">
              <PoolTracePaths
                samples={totalSamples}
                mode={mode}
                x={totalGeom.x}
                y={totalGeom.y}
                segmentRuns={totalGeom.segmentRuns}
                stroke="var(--text-primary)"
                strokeWidth={2.5}
                fillId={`${id}-total-fill`}
                showResetRisers
                sparseProjection={totalSparseProjection}
                keyPrefix="total"
              />
              {mode === 'remaining' && visible(totalSeries.poolEmptyAtMs) && (
                <circle
                  cx={totalGeom.x(totalSeries.poolEmptyAtMs)}
                  cy={totalGeom.y(0)}
                  r="4.5"
                  fill="var(--bg-primary)"
                  stroke="var(--text-primary)"
                  strokeWidth="2"
                >
                  <title>{`${t('quota_pool.pool_empty')}: ${date(totalSeries.poolEmptyAtMs)}`}</title>
                </circle>
              )}
            </g>
          )}

          {visibleLaneSets.map(({ lane, visibleSamples, sparseProjection }, index) => {
            const geom = laneGeoms[index];
            const box = layout.laneBoxes[index];
            const resets = laneResetSets[index];
            const shape = providerMarkerShape(lane.provider);
            const resetPointByTime = new Map(
              stops
                .filter((s) => s.projected)
                .map((s) => [
                  s.atMs,
                  {
                    before: s.lanes[index]?.before ?? null,
                    after: s.lanes[index]?.after ?? null,
                  },
                ])
            );

            return (
              <g
                key={`lane-${index}`}
                {...poolProviderStyle(lane.provider)}
                data-series={lane.instanceId ?? lane.provider}
                data-lane-capacity={lane.capacityPoints}
              >
                <PoolTracePaths
                  samples={visibleSamples}
                  mode={mode}
                  x={geom.x}
                  y={geom.y}
                  segmentRuns={geom.segmentRuns}
                  stroke="var(--pool-accent)"
                  strokeWidth={singleStandaloneLane ? 2.4 : 2}
                  fillId={`${id}-lane-fill-${index}`}
                  includeProjected={!lane.historyOnly}
                  showResetRisers
                  sparseProjection={sparseProjection}
                  keyPrefix={`lane-${index}`}
                />
                {/* Per-lane scheduled reset guides, shape markers, and non-overlapping +gain labels. */}
                {resets.map((reset, resetIdx) => {
                  const pt = resetPointByTime.get(reset.atMs);
                  const hasAfter = pt?.after !== null && pt?.after !== undefined;
                  const markerY = hasAfter ? geom.y(pt.after!) : box.top;
                  const beforeY =
                    pt?.before !== null && pt?.before !== undefined ? geom.y(pt.before) : markerY;
                  const sideY = reset.anchor === 'end' ? beforeY : markerY;
                  const topLabelY = box.top + 11;
                  const bottomLabelY = box.bottom - 5;
                  const labelY =
                    Math.abs(sideY - topLabelY) >= Math.abs(sideY - bottomLabelY)
                      ? topLabelY
                      : bottomLabelY;
                  const hitsCrosshair =
                    activeX !== null &&
                    (Math.abs(reset.rx - activeX) < 18 ||
                      (activeX >= reset.labelLeft - 12 && activeX <= reset.labelRight + 12));
                  return (
                    <g
                      key={`lane-reset-${index}-${resetIdx}`}
                      className={styles.laneResetMarker}
                      data-reset-provider={lane.provider}
                    >
                      <line
                        className={styles.laneResetGuide}
                        x1={reset.rx}
                        x2={reset.rx}
                        y1={box.top}
                        y2={box.bottom}
                      />
                      {hasAfter ? (
                        <path
                          d={providerGlyphPath(shape, reset.rx, markerY, 3.8)}
                          fill="var(--pool-accent)"
                          stroke="var(--bg-primary)"
                          strokeWidth="1.2"
                        />
                      ) : (
                        <line
                          x1={reset.rx}
                          x2={reset.rx}
                          y1={box.top - 4}
                          y2={box.top + 3}
                          stroke="var(--pool-accent)"
                          strokeWidth="2"
                        />
                      )}
                      {reset.showLabel && !hitsCrosshair && (
                        <text
                          x={reset.labelX}
                          y={labelY}
                          textAnchor={reset.anchor}
                          className={styles.laneResetGain}
                        >
                          {reset.text}
                        </text>
                      )}
                      <title>{`${laneLabel(lane)} · ${t('quota_pool.reset')}: ${date(reset.atMs)} · ${reset.text} ${unit}`}</title>
                    </g>
                  );
                })}
                {/* Pool-empty marker inside this provider's own lane. */}
                {mode === 'remaining' && !lane.historyOnly && visible(lane.poolEmptyAtMs) && (
                  <g data-empty-marker={lane.provider}>
                    <circle
                      cx={geom.x(lane.poolEmptyAtMs)}
                      cy={geom.y(0)}
                      r="4"
                      fill="var(--bg-primary)"
                      stroke="var(--pool-accent)"
                      strokeWidth="2"
                    >
                      <title>{`${laneLabel(lane)} · ${t('quota_pool.pool_empty')}: ${date(lane.poolEmptyAtMs)}`}</title>
                    </circle>
                  </g>
                )}
              </g>
            );
          })}

          {/* Snapshot vertical rule across Total and all lanes. */}
          {snapshotX !== null && (
            <line
              x1={snapshotX}
              x2={snapshotX}
              y1={topPlotY}
              y2={bottomPlotY}
              className={styles.nowLine}
            />
          )}

          {/* Synchronized vertical scrub crosshair & active dots across Total + lanes. */}
          {activeStop && (
            <g data-crosshair="true">
              <line
                x1={x(activeStop.atMs)}
                x2={x(activeStop.atMs)}
                y1={topPlotY}
                y2={bottomPlotY}
                stroke="var(--text-tertiary)"
                opacity="0.55"
              />
              {totalGeom && activeStop.totalAfter !== null && (
                <circle
                  cx={x(activeStop.atMs)}
                  cy={totalGeom.y(activeStop.totalAfter)}
                  r="4.8"
                  fill="var(--text-primary)"
                  stroke="var(--bg-primary)"
                  strokeWidth="2"
                />
              )}
              {visibleLaneSets.map(({ lane }, index) => {
                if (lane.historyOnly && activeStop.projected) return null;
                const val = activeStop.lanes[index];
                if (!val || val.after === null) return null;
                return (
                  <circle
                    key={`crosshair-dot-${index}`}
                    {...poolProviderStyle(lane.provider)}
                    cx={x(activeStop.atMs)}
                    cy={laneGeoms[index].y(val.after)}
                    r={singleStandaloneLane ? '5' : '4'}
                    fill="var(--pool-accent)"
                    stroke="var(--bg-primary)"
                    strokeWidth="1.8"
                  />
                );
              })}
            </g>
          )}
        </g>

        {/* Top-edge provider-colored reset ticks on the Total plot (unclipped above top edge). */}
        {layout.totalBox &&
          totalTicks.map((tick, tickIdx) => (
            <line
              key={`total-tick-${tickIdx}`}
              {...poolProviderStyle(tick.provider)}
              data-total-reset-tick={tick.provider}
              x1={tick.x}
              x2={tick.x}
              y1={layout.totalBox!.top - 6}
              y2={layout.totalBox!.top + 4}
              stroke="var(--pool-accent)"
              strokeWidth="2.2"
            >
              <title>{`${tick.label} · ${t('quota_pool.reset')}: ${date(tick.atMs)} · +${number(tick.gainPoints)} ${unit}`}</title>
            </line>
          ))}

        {snapshotX !== null && (
          <text
            className={styles.nowLabel}
            x={snapshotAnchor === 'end' ? snapshotX - 4 : snapshotX}
            y={topPlotY - 12}
            textAnchor={snapshotAnchor}
          >
            {snapshotText}
          </text>
        )}

        {!hasValues && (
          <text
            x={(layout.left + layout.right) / 2}
            y={layout.height / 2}
            textAnchor="middle"
            className={styles.emptyChart}
          >
            {t('quota_pool.no_history')}
          </text>
        )}
        {hasValues &&
          !hasProjection &&
          mode === 'remaining' &&
          lanes.every((lane) => lane.forecastState === 'ready' || lane.historyOnly) &&
          visible(nowMs) &&
          x(nowMs) < layout.right - 130 && (
            <text
              x={(x(nowMs) + layout.right) / 2}
              y={(topPlotY + (layout.totalBox?.bottom ?? bottomPlotY)) / 2}
              textAnchor="middle"
              className={styles.emptyChart}
            >
              {t('quota_pool.projection_unavailable')}
            </text>
          )}
      </svg>

      {/* Expand/collapse button when 4+ providers are combined. */}
      {!skipDuplicateLane && !minimized && lanes.length > DEFAULT_VISIBLE_LANES && (
        <button
          type="button"
          className={styles.lanesShowAll}
          aria-expanded={showAllLanes}
          onClick={() => setShowAllLanes((prev) => !prev)}
        >
          {showAllLanes
            ? t('quota_pool.show_fewer_providers')
            : t('quota_pool.show_all_providers', { count: lanes.length })}
        </button>
      )}

      <div className={styles.chartFooter}>
        <div className={styles.legend}>
          {/* When lanes are hidden, encode provider colors as vertical reset ticks (matching the plot). */}
          {showTickLegend && (
            <>
              <span className={styles.legendGroupLabel}>{t('quota_pool.scheduled_reset')}:</span>
              {lanes
                .filter((lane) => !lane.historyOnly && tickProviders.has(lane.provider))
                .map((lane, index) => (
                  <span key={`min-key-${index}`} {...poolProviderStyle(lane.provider)}>
                    <i className={styles.resetKey} />
                    {laneLabel(lane)}
                    {lane.forecastState !== 'ready' &&
                      ` · ${t(`quota_pool.state.${lane.forecastState}`)}`}
                  </span>
                ))}
            </>
          )}
          <span data-style-key data-divider={showTickLegend || undefined}>
            <i />
            {t('quota_pool.recorded')}
          </span>
          {hasProjection && (
            <span data-style-key>
              <i className={styles.dashed} />
              {t('quota_pool.projected')}
            </span>
          )}
          {mode === 'remaining' && hasAnyReset && !showTickLegend && (
            <span data-style-key>
              <i className={styles.resetKey} />
              {t('quota_pool.scheduled_reset')}
            </span>
          )}
        </div>
      </div>

      {/* Polite screen-reader summary of the committed moment + full scheduled reset list. */}
      <div id={`${id}-readout`} className={styles.srOnly} aria-live="polite">
        {describeStop(committedStop, scrub.isAtLatestCommit)}
        {stops.length === 1 ? ` · ${t('quota_pool.single_sample')}` : ''}
      </div>
      {allScheduledResets.length > 0 && (
        <ul className={styles.srOnly} aria-label={t('quota_pool.scheduled_resets_label')}>
          {allScheduledResets.map((reset, idx) => (
            <li key={`${reset.provider}-${reset.atMs}-${idx}`}>
              {`${reset.label}: ${date(reset.atMs)} +${number(reset.gainPoints)} ${unit}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
