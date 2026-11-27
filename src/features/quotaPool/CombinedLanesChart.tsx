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
  computeHybridFrame,
  computeSpreadBand,
  findNextReset,
  laneIdentity,
  latestRecordedStopIndex,
  normalizeSamplesToPercent,
  placeTotalResetTicks,
  readCombinedBackgroundMode,
  sameVisibleTrace,
  SMART_BAND_THRESHOLD,
  writeCombinedBackgroundMode,
  type CombinedBackgroundMode,
  type LaneStop,
  type LaneTrace,
} from './combinedLanesModel';
import { CombinedProviderBars } from './CombinedProviderBars';
import { PoolTracePaths } from './PoolTracePaths';
import { formatPoolDate, formatPoolNumber, formatPoolTick } from './presentation';
import { poolProviderLabel, poolProviderStyle } from './providerPresentation';
import { useChartScrub } from './useChartScrub';
import styles from './QuotaPoolPage.module.scss';

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
  const [bgMode, setBgMode] = useState<CombinedBackgroundMode>(() => readCombinedBackgroundMode());
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null);
  const [pinnedProviders, setPinnedProviders] = useState<string[]>([]);

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

  const setBackgroundMode = (next: CombinedBackgroundMode) => {
    setBgMode(next);
    writeCombinedBackgroundMode(next);
  };

  const isRemaining = mode === 'remaining';
  const unit = t(`quota_pool.${isRemaining ? 'points' : 'points_hour'}`);
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
    const key = laneIdentity(lane);
    const samples = inRange(chartSamples(lane.recorded, lane.projected, mode), fromMs, toMs);
    const visibleSamples = lane.historyOnly ? samples.filter((s) => !s.projected) : samples;
    return {
      lane,
      key,
      samples,
      visibleSamples,
      normalizedSamples: isRemaining
        ? normalizeSamplesToPercent(visibleSamples, lane.capacityPoints)
        : visibleSamples,
      sparseProjection:
        !lane.historyOnly && samples.filter((sample) => sample.projected).length < 3,
    };
  });

  // Restrict focus sets to currently mounted lanes so removed providers never leave charts dimmed.
  const validKeys = new Set(laneSampleSets.map((set) => set.key));
  const activePinned = pinnedProviders.filter((key) => validKeys.has(key));
  const activeHovered = hoveredProvider && validKeys.has(hoveredProvider) ? hoveredProvider : null;
  const focusKeys = new Set<string>(activePinned);
  if (activeHovered) focusKeys.add(activeHovered);
  const hasFocus = !minimized && focusKeys.size > 0;

  const hasTotal = Boolean(totalSeries);
  const skipDuplicateLane =
    hasTotal &&
    lanes.length === 1 &&
    sameVisibleTrace(totalSamples, laneSampleSets[0].visibleSamples, mode);
  const showProviderGrid = !minimized && !skipDuplicateLane && lanes.length > 0;
  const showBgSwitch = showProviderGrid && lanes.length > 1;

  // Background decluttering: "smart" draws quiet background lines up to 4 providers and switches
  // to a translucent min–max spread envelope at 5+ providers; "ghost" always keeps quiet lines.
  const showSpreadBand =
    isRemaining && showProviderGrid && bgMode === 'smart' && lanes.length >= SMART_BAND_THRESHOLD;
  const showQuietLines =
    showProviderGrid && (bgMode === 'ghost' || lanes.length < SMART_BAND_THRESHOLD);

  const normalizedTotalSamples =
    isRemaining && totalSeries
      ? normalizeSamplesToPercent(totalSamples, totalSeries.capacityPoints)
      : totalSamples;

  const plottedLaneSets = showProviderGrid
    ? laneSampleSets.filter((set) => showQuietLines || focusKeys.has(set.key))
    : [];

  // Shared plot scale: normalized % (usually 0–100%) in remaining mode; signed points/h in rate mode.
  const remainingMaxPct = (() => {
    if (!isRemaining) return 100;
    let peak = 100;
    const inspect = (samples: readonly { point: { remainingPoints: number | null } }[]) => {
      for (const s of samples) {
        if (s.point.remainingPoints !== null && s.point.remainingPoints > peak) {
          peak = s.point.remainingPoints;
        }
      }
    };
    if (hasTotal) inspect(normalizedTotalSamples);
    if (showProviderGrid) {
      for (const set of laneSampleSets) inspect(set.normalizedSamples);
    }
    return peak <= 100 ? 100 : Math.ceil(peak / 25) * 25;
  })();

  const rateProbeSamples = !isRemaining
    ? [...(hasTotal ? totalSamples : []), ...plottedLaneSets.flatMap((set) => set.visibleSamples)]
    : [];
  const rateProbeAxis = !isRemaining
    ? chartGeometry(rateProbeSamples, mode, 0, fromMs, toMs)
    : null;
  const yTicks = isRemaining
    ? axisTicks(0, remainingMaxPct)
    : axisTicks(rateProbeAxis!.min, rateProbeAxis!.max);
  const leftLabels = yTicks.map((v) => (isRemaining ? `${number(v)}%` : number(v)));
  const showRightAxis =
    isRemaining && !narrow && hasTotal && Boolean(totalSeries && totalSeries.capacityPoints > 0);
  const rightLabels =
    showRightAxis && totalSeries
      ? yTicks.map((pct) => number((pct / 100) * totalSeries.capacityPoints))
      : [];

  const leftChars = Math.max(
    1,
    ...leftLabels.map((s) => s.length),
    !narrow && !isRemaining ? Math.ceil(unit.length * 0.72) : 0
  );
  const rightChars = showRightAxis
    ? Math.max(
        ...rightLabels.map((s) => s.length),
        Math.ceil(t('quota_pool.total_points_axis').length * 0.75)
      )
    : 0;

  const frame = computeHybridFrame({
    width,
    minimized,
    leftChars,
    rightChars,
  });

  const sharedSamples = isRemaining ? normalizedTotalSamples : rateProbeSamples;
  const geom = chartGeometry(
    sharedSamples,
    mode,
    isRemaining ? remainingMaxPct : 0,
    fromMs,
    toMs,
    frame
  );
  // Ensure remaining mode always anchors cleanly to [0, remainingMaxPct] even when Total is empty.
  const yOf = isRemaining
    ? (pct: number) => frame.bottom - (pct / (remainingMaxPct || 100)) * (frame.bottom - frame.top)
    : geom.y;
  const x = geom.x;

  // Build segmentRuns bound to the exact shared yOf scale so normalized Total & lanes align 1:1.
  const sharedGeom = isRemaining
    ? chartGeometry(
        [
          {
            point: {
              atMs: fromMs,
              remainingPoints: remainingMaxPct,
              burnPointsPerHour: null,
              drainPointsPerHour: null,
            },
            projected: false,
          },
        ],
        'remaining',
        remainingMaxPct,
        fromMs,
        toMs,
        frame
      )
    : geom;

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
    layoutWidth: frame.width,
    x,
    onEscapeAtRest: activePinned.length > 0 ? () => setPinnedProviders([]) : undefined,
  });
  const activeStop = stops[scrub.activeIndex];
  const committedStop = stops[scrub.committedIndex];
  const { isInspecting, showNowButton } = scrub;

  const spreadRuns = showSpreadBand
    ? computeSpreadBand(
        laneSampleSets.map((set) => set.normalizedSamples),
        lanes
      )
    : [];

  // Derive empty-state & Projected legend strictly from traces actually plotted on the SVG.
  const hasValues =
    Boolean(hasTotal && normalizedTotalSamples.some((s) => s.point[field] !== null)) ||
    plottedLaneSets.some((set) => set.normalizedSamples.some((s) => s.point[field] !== null)) ||
    spreadRuns.length > 0;
  const hasProjection =
    Boolean(
      hasTotal &&
      totalSeries &&
      normalizedTotalSamples.some((s) => s.projected && s.point[field] !== null)
    ) ||
    plottedLaneSets.some((set) =>
      set.normalizedSamples.some((s) => s.projected && s.point[field] !== null)
    ) ||
    (spreadRuns.length > 0 &&
      laneSampleSets.some(
        (set) =>
          !set.lane.historyOnly &&
          set.normalizedSamples.some((s) => s.projected && s.point[field] !== null)
      ));

  const allTotalTicks = isRemaining ? placeTotalResetTicks(lanes, fromMs, toMs, x, laneLabel) : [];
  const visibleTicks = hasFocus
    ? allTotalTicks.filter((tick) => focusKeys.has(tick.laneKey))
    : allTotalTicks;
  const showTickLegend = isRemaining && (minimized || skipDuplicateLane) && visibleTicks.length > 0;
  const tickLaneKeys = new Set(visibleTicks.map((tick) => tick.laneKey));
  const nextReset = isRemaining ? findNextReset(lanes, nowMs, toMs, laneLabel) : null;

  const allScheduledResets = isRemaining
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
      : frame.right - snapshotX < 64
        ? 'end'
        : snapshotX - frame.left < 64
          ? 'start'
          : 'middle';

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

  const totalPctAtActive =
    isRemaining && totalSeries && totalSeries.capacityPoints > 0 && activeStop?.totalAfter != null
      ? Math.round((activeStop.totalAfter / totalSeries.capacityPoints) * 100)
      : null;

  const togglePinProvider = (key: string) => {
    setPinnedProviders((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]
    );
  };

  return (
    <div className={styles.chart} ref={container}>
      {/* Thumb-safe constant-height readout bar above the plot. */}
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
                    {isRemaining ? ` / ${number(totalSeries.capacityPoints)}` : `\u00a0${unit}`}
                  </strong>
                  {totalPctAtActive !== null && ` (${totalPctAtActive}%)`}
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
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        role="img"
        aria-labelledby={`${id}-title ${id}-desc`}
        aria-describedby={`${id}-readout`}
        tabIndex={stops.length > 1 ? 0 : undefined}
        {...scrub.svgHandlers}
      >
        <title id={`${id}-title`}>
          {t('quota_pool.chart_title', {
            provider:
              !hasTotal && lanes.length === 1
                ? laneLabel(lanes[0])
                : t('quota_pool.combined_usage'),
            mode: t(`quota_pool.${mode}`),
          })}
        </title>
        <desc id={`${id}-desc`}>
          {t(
            isRemaining
              ? 'quota_pool.combined_lanes_description'
              : 'quota_pool.combined_lanes_rate_description'
          )}
        </desc>
        <defs>
          <linearGradient id={`${id}-total-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--text-primary)" stopOpacity="0.14" />
            <stop offset="100%" stopColor="var(--text-primary)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${id}-empty-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--text-primary)" stopOpacity="0" />
            <stop offset="100%" stopColor="var(--text-primary)" stopOpacity="0" />
          </linearGradient>
          <clipPath id={`${id}-clip`}>
            <rect
              x={frame.left - 6}
              y={frame.top - 8}
              width={frame.right - frame.left + 12}
              height={Math.max(1, frame.bottom - frame.top + 16)}
            />
          </clipPath>
        </defs>

        {!isRemaining && (
          <text
            className={styles.axisUnit}
            x={narrow ? 0 : frame.left - 10}
            y={frame.top - 16}
            textAnchor={narrow ? 'start' : 'end'}
          >
            {unit}
          </text>
        )}
        {showRightAxis && (
          <text
            className={styles.axisUnitRight}
            x={frame.right + 10}
            y={frame.top - 16}
            textAnchor="start"
          >
            {t('quota_pool.total_points_axis')}
          </text>
        )}

        {/* Shared vertical date/hour gridlines. */}
        {(hourly ? hourTicks : dayTicks)(fromMs, toMs, tickCount).map((at) => {
          const edge = 40;
          return (
            <g key={at} className={styles.grid}>
              <line x1={x(at)} x2={x(at)} y1={frame.top} y2={frame.bottom} />
              <text
                x={x(at)}
                y={frame.axisY}
                textAnchor={
                  x(at) - frame.left < edge
                    ? 'start'
                    : frame.right - x(at) < edge
                      ? 'end'
                      : 'middle'
                }
              >
                {formatPoolTick(at, i18n.language, hourly)}
              </text>
            </g>
          );
        })}

        {/* Shared Y-axis gridlines: 0–100% left (+ exact Total pts right on desktop), or points/h for rates. */}
        {yTicks.map((value, index) => {
          const tickY = yOf(value);
          const isZeroLine = !isRemaining && value === 0 && (rateProbeAxis?.min ?? 0) < 0;
          return (
            <g key={`y-${index}`} className={isZeroLine ? styles.zeroAxis : styles.grid}>
              <line x1={frame.left} x2={frame.right} y1={tickY} y2={tickY} />
              <text x={frame.left - 10} y={tickY + 4} textAnchor="end">
                {leftLabels[index]}
              </text>
              {showRightAxis && (
                <text
                  x={frame.right + 10}
                  y={tickY + 4}
                  textAnchor="start"
                  className={styles.axisRightTick}
                >
                  {rightLabels[index]}
                </text>
              )}
            </g>
          );
        })}

        {/* Clipped data layer: spread band, quiet background lines, bold Total, spotlighted providers. */}
        <g clipPath={`url(#${id}-clip)`}>
          {spreadRuns.length > 0 && (
            <g data-spread-band="true" opacity={hasFocus ? 0.45 : 1}>
              {spreadRuns.map((run, runIdx) => {
                const upper = run
                  .map((pt, i) => `${i === 0 ? 'M' : 'L'}${x(pt.atMs)},${yOf(pt.maxPct)}`)
                  .join(' ');
                const lower = run
                  .map((pt, i) => `${i === 0 ? 'M' : 'L'}${x(pt.atMs)},${yOf(pt.minPct)}`)
                  .join(' ');
                const lowerRev = [...run]
                  .reverse()
                  .map((pt) => `L${x(pt.atMs)},${yOf(pt.minPct)}`)
                  .join(' ');
                return (
                  <g key={`spread-${runIdx}`}>
                    <path d={`${upper} ${lowerRev} Z`} className={styles.spreadBandFill} />
                    <path d={upper} className={styles.spreadBandEdge} />
                    <path d={lower} className={styles.spreadBandEdge} />
                  </g>
                );
              })}
            </g>
          )}

          {/* Quiet background provider curves (when <= 4 in Smart mode, or always in Ghost lines mode). */}
          {showQuietLines &&
            laneSampleSets.map((set) => {
              if (focusKeys.has(set.key) || !set.normalizedSamples.length) return null;
              const quietOpacity = hasFocus ? 0.12 : lanes.length <= 4 ? 0.48 : 0.24;
              const quietWidth = lanes.length <= 4 ? 1.5 : 1.15;
              return (
                <g
                  key={`quiet-${set.key}`}
                  {...poolProviderStyle(set.lane.provider)}
                  data-series={set.key}
                  data-emphasis="quiet"
                  opacity={quietOpacity}
                >
                  <PoolTracePaths
                    samples={set.normalizedSamples}
                    mode={mode}
                    x={x}
                    y={yOf}
                    segmentRuns={sharedGeom.segmentRuns}
                    stroke="var(--pool-accent)"
                    strokeWidth={quietWidth}
                    fillId={`${id}-empty-fill`}
                    includeProjected={!set.lane.historyOnly}
                    showResetRisers
                    sparseProjection={set.sparseProjection}
                    keyPrefix={`quiet-${set.key}`}
                  />
                </g>
              );
            })}

          {/* Bold neutral Total curve. */}
          {hasTotal && totalSeries && (
            <g data-series="total" opacity={hasFocus ? 0.4 : 1}>
              <PoolTracePaths
                samples={normalizedTotalSamples}
                mode={mode}
                x={x}
                y={yOf}
                segmentRuns={sharedGeom.segmentRuns}
                stroke="var(--text-primary)"
                strokeWidth={2.6}
                fillId={hasFocus ? `${id}-empty-fill` : `${id}-total-fill`}
                showResetRisers
                sparseProjection={totalSparseProjection}
                keyPrefix="total"
              />
              {isRemaining && visible(totalSeries.poolEmptyAtMs) && (
                <circle
                  cx={x(totalSeries.poolEmptyAtMs)}
                  cy={yOf(0)}
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

          {/* Spotlighted / pinned provider curves (1, 2, or more head-to-head on the shared scale). */}
          {!minimized &&
            laneSampleSets.map((set) => {
              if (!focusKeys.has(set.key) || !set.normalizedSamples.length) return null;
              return (
                <g
                  key={`focus-${set.key}`}
                  {...poolProviderStyle(set.lane.provider)}
                  data-series={set.key}
                  data-emphasis="focused"
                >
                  <PoolTracePaths
                    samples={set.normalizedSamples}
                    mode={mode}
                    x={x}
                    y={yOf}
                    segmentRuns={sharedGeom.segmentRuns}
                    stroke="var(--pool-accent)"
                    strokeWidth={2.4}
                    fillId={`${id}-empty-fill`}
                    includeProjected={!set.lane.historyOnly}
                    showResetRisers
                    sparseProjection={set.sparseProjection}
                    keyPrefix={`focus-${set.key}`}
                  />
                </g>
              );
            })}

          {/* Empty-pool markers on the 0% baseline (kept visible so imminent depletions never hide). */}
          {isRemaining &&
            !minimized &&
            laneSampleSets.map((set) => {
              if (set.lane.historyOnly || !visible(set.lane.poolEmptyAtMs)) return null;
              const markerOpacity = !hasFocus || focusKeys.has(set.key) ? 1 : 0.22;
              return (
                <g
                  key={`empty-${set.key}`}
                  {...poolProviderStyle(set.lane.provider)}
                  data-empty-marker={set.lane.provider}
                  opacity={markerOpacity}
                >
                  <circle
                    cx={x(set.lane.poolEmptyAtMs)}
                    cy={yOf(0)}
                    r="4.2"
                    fill="var(--bg-primary)"
                    stroke="var(--pool-accent)"
                    strokeWidth="2"
                  >
                    <title>{`${laneLabel(set.lane)} · ${t('quota_pool.pool_empty')}: ${date(set.lane.poolEmptyAtMs)}`}</title>
                  </circle>
                </g>
              );
            })}

          {/* Snapshot vertical rule. */}
          {snapshotX !== null && (
            <line
              x1={snapshotX}
              x2={snapshotX}
              y1={frame.top}
              y2={frame.bottom}
              className={styles.nowLine}
            />
          )}

          {/* Synchronized vertical scrub crosshair & active dots. */}
          {activeStop && (
            <g data-crosshair="true">
              <line
                x1={x(activeStop.atMs)}
                x2={x(activeStop.atMs)}
                y1={frame.top}
                y2={frame.bottom}
                stroke="var(--text-tertiary)"
                opacity="0.55"
              />
              {hasTotal &&
                totalSeries &&
                activeStop.totalAfter !== null &&
                (!isRemaining || totalSeries.capacityPoints > 0) && (
                  <circle
                    cx={x(activeStop.atMs)}
                    cy={yOf(
                      isRemaining
                        ? (activeStop.totalAfter / totalSeries.capacityPoints) * 100
                        : activeStop.totalAfter
                    )}
                    r="4.6"
                    fill="var(--text-primary)"
                    stroke="var(--bg-primary)"
                    strokeWidth="2"
                    opacity={hasFocus ? 0.45 : 1}
                  />
                )}
              {!minimized &&
                laneSampleSets.map((set, index) => {
                  const showDot = focusKeys.has(set.key) || (!hasTotal && showQuietLines);
                  if (!showDot) return null;
                  if (set.lane.historyOnly && activeStop.projected) return null;
                  const val = activeStop.lanes[index];
                  if (!val || val.after === null) return null;
                  if (isRemaining && !(set.lane.capacityPoints > 0)) return null;
                  const yVal = isRemaining
                    ? (val.after / set.lane.capacityPoints) * 100
                    : val.after;
                  return (
                    <circle
                      key={`crosshair-dot-${set.key}`}
                      {...poolProviderStyle(set.lane.provider)}
                      cx={x(activeStop.atMs)}
                      cy={yOf(yVal)}
                      r="4.5"
                      fill="var(--pool-accent)"
                      stroke="var(--bg-primary)"
                      strokeWidth="1.8"
                    />
                  );
                })}
            </g>
          )}
        </g>

        {/* Top-edge provider-colored reset ticks (unclipped above top edge). */}
        {visibleTicks.map((tick, tickIdx) => (
          <line
            key={`total-tick-${tickIdx}`}
            {...poolProviderStyle(tick.provider)}
            data-total-reset-tick={tick.provider}
            x1={tick.x}
            x2={tick.x}
            y1={frame.top - 6}
            y2={frame.top + 4}
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
            y={frame.top - 12}
            textAnchor={snapshotAnchor}
          >
            {snapshotText}
          </text>
        )}

        {!hasValues && (
          <text
            x={(frame.left + frame.right) / 2}
            y={frame.height / 2}
            textAnchor="middle"
            className={styles.emptyChart}
          >
            {t('quota_pool.no_history')}
          </text>
        )}
        {hasValues &&
          !hasProjection &&
          isRemaining &&
          lanes.every((lane) => lane.forecastState === 'ready' || lane.historyOnly) &&
          visible(nowMs) &&
          x(nowMs) < frame.right - 130 && (
            <text
              x={(x(nowMs) + frame.right) / 2}
              y={(frame.top + frame.bottom) / 2}
              textAnchor="middle"
              className={styles.emptyChart}
            >
              {t('quota_pool.projection_unavailable')}
            </text>
          )}
      </svg>

      {/* Live synchronized provider bar grid + per-browser Smart/Ghost background toggle. */}
      {showProviderGrid && (
        <CombinedProviderBars
          items={laneSampleSets}
          activeStop={activeStop}
          isRemaining={isRemaining}
          unit={unit}
          laneLabel={laneLabel}
          activePinned={activePinned}
          focusKeys={focusKeys}
          hasFocus={hasFocus}
          bgMode={bgMode}
          showBgSwitch={showBgSwitch}
          onSelectBgMode={setBackgroundMode}
          onHoverProvider={setHoveredProvider}
          onTogglePin={togglePinProvider}
          onClearPins={() => setPinnedProviders([])}
        />
      )}

      <div className={styles.chartFooter}>
        <div className={styles.legend}>
          {showTickLegend && (
            <>
              <span className={styles.legendGroupLabel}>{t('quota_pool.scheduled_reset')}:</span>
              {laneSampleSets
                .filter((set) => !set.lane.historyOnly && tickLaneKeys.has(set.key))
                .map(({ lane, key }) => (
                  <span key={`min-key-${key}`} {...poolProviderStyle(lane.provider)}>
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
          {spreadRuns.length > 0 && (
            <span data-style-key>
              <i className={styles.spreadKey} />
              {t('quota_pool.provider_spread_band')}
            </span>
          )}
          {isRemaining && visibleTicks.length > 0 && !showTickLegend && (
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
