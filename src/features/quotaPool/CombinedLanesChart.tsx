import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
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
  buildSpreadPaths,
  collectScheduledResets,
  computeHybridFrame,
  computeSpreadBand,
  describeCombinedStop,
  findNextReset,
  formatNormalizedPercentLabel,
  latestRecordedStopIndex,
  normalizePercentValue,
  normalizeSamplesToPercent,
  overflowMarkerXs,
  placeTotalResetTicks,
  readCombinedBackgroundMode,
  sameVisibleTrace,
  sampleHasOverflow,
  shouldUsePercentScale,
  SMART_BAND_THRESHOLD,
  writeCombinedBackgroundMode,
  type CombinedBackgroundMode,
  type LaneTrace,
} from './combinedLanesModel';
import { CombinedProviderBars } from './CombinedProviderBars';
import { poolKey } from './poolOrder';
import { PoolTracePaths } from './PoolTracePaths';
import { formatPoolDate, formatPoolNumber, formatPoolTick } from './presentation';
import { poolProviderLabel, poolProviderStyle } from './providerPresentation';
import { useChartScrub } from './useChartScrub';
import styles from './QuotaPoolPage.module.scss';

const MAX_INLINE_RESET_PILLS = 2;
const EMPTY_KEY_SET: ReadonlySet<string> = new Set();

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

  const laneLabel = useCallback(
    (lane: LaneTrace) => {
      const multi = lanes.filter((other) => other.provider === lane.provider).length > 1;
      return `${poolProviderLabel(t, lane.provider, lane.displayName)}${(lane.sourceLabel || lane.instanceId) && multi ? ` · ${lane.sourceLabel ?? lane.instanceId}` : ''}`;
    },
    [lanes, t]
  );
  const number = (value: number | null) => formatPoolNumber(value, i18n.language);
  const date = (value: number) => formatPoolDate(value, i18n.language);
  const visible = (at: number | null): at is number => at !== null && at >= fromMs && at <= toMs;

  const totalSamples = useMemo(
    () =>
      totalSeries
        ? inRange(chartSamples(totalSeries.recorded, totalSeries.projected, mode), fromMs, toMs)
        : [],
    [totalSeries, mode, fromMs, toMs]
  );
  const laneRawSets = useMemo(
    () =>
      lanes.map((lane) => {
        const key = poolKey(lane);
        const samples = inRange(chartSamples(lane.recorded, lane.projected, mode), fromMs, toMs);
        const visibleSamples = lane.historyOnly ? samples.filter((s) => !s.projected) : samples;
        return {
          lane,
          key,
          samples,
          visibleSamples,
          sparseProjection:
            !lane.historyOnly && samples.filter((sample) => sample.projected).length < 3,
        };
      }),
    [lanes, mode, fromMs, toMs]
  );

  // Restrict focus sets to currently mounted lanes so removed providers never leave charts dimmed.
  const validKeys = new Set(laneRawSets.map((set) => set.key));
  const activePinned = pinnedProviders.filter((key) => validKeys.has(key));
  const activeHovered = hoveredProvider && validKeys.has(hoveredProvider) ? hoveredProvider : null;
  const focusKeys = new Set<string>(activePinned);
  if (activeHovered) focusKeys.add(activeHovered);
  const hasFocus = !minimized && focusKeys.size > 0;

  const hasTotal = Boolean(totalSeries);
  const skipDuplicateLane =
    hasTotal &&
    lanes.length === 1 &&
    sameVisibleTrace(totalSamples, laneRawSets[0].visibleSamples, mode);
  // Hide cards when minimized, but keep compact provider traces whenever Total is withheld.
  const showProviderCards = !minimized && !skipDuplicateLane && lanes.length > 0;
  const showProviderTraces = showProviderCards || (minimized && !hasTotal && lanes.length > 0);

  const requireAllLanesPlotted = minimized && !hasTotal;
  const unfocusedPercentScale = useMemo(
    () =>
      shouldUsePercentScale({
        isRemaining,
        totalSeries,
        totalSamples,
        laneSets: laneRawSets,
        focusKeys: EMPTY_KEY_SET,
        hasFocus: false,
        requireAllLanesPlotted,
      }),
    [isRemaining, totalSeries, totalSamples, laneRawSets, requireAllLanesPlotted]
  );
  const usePercentScale = shouldUsePercentScale({
    isRemaining,
    totalSeries,
    totalSamples,
    laneSets: laneRawSets,
    focusKeys,
    hasFocus,
    requireAllLanesPlotted,
  });

  const normalizedLaneSamples = useMemo(
    () =>
      unfocusedPercentScale
        ? laneRawSets.map((set) =>
            normalizeSamplesToPercent(set.visibleSamples, set.lane.capacityPoints)
          )
        : [],
    [unfocusedPercentScale, laneRawSets]
  );

  // Memoize spread computation strictly against unfocused trace data and visible range so
  // scrubbing, hover, pin, and Ghost toggles never recompute it. Minimized no-Total charts
  // always keep colored provider lines rather than an unlabeled spread band.
  const baseSpread = useMemo(() => {
    if (!unfocusedPercentScale || !showProviderCards || lanes.length < SMART_BAND_THRESHOLD) {
      return { runs: [], fullyCovered: false };
    }
    return computeSpreadBand(normalizedLaneSamples, lanes, fromMs, toMs);
  }, [unfocusedPercentScale, showProviderCards, lanes, normalizedLaneSamples, fromMs, toMs]);

  const laneSampleSets = useMemo(
    () =>
      laneRawSets.map((set, index) => ({
        ...set,
        plotSamples: usePercentScale
          ? (normalizedLaneSamples[index] ??
            normalizeSamplesToPercent(set.visibleSamples, set.lane.capacityPoints))
          : set.visibleSamples,
        hasOverflow:
          usePercentScale &&
          sampleHasOverflow(set.visibleSamples, set.lane.capacityPoints, fromMs, toMs),
      })),
    [laneRawSets, usePercentScale, normalizedLaneSamples, fromMs, toMs]
  );
  const plotTotalSamples = useMemo(
    () =>
      usePercentScale && totalSeries
        ? normalizeSamplesToPercent(totalSamples, totalSeries.capacityPoints)
        : totalSamples,
    [usePercentScale, totalSeries, totalSamples]
  );
  const totalHasOverflow = useMemo(
    () =>
      usePercentScale && totalSeries
        ? sampleHasOverflow(totalSamples, totalSeries.capacityPoints, fromMs, toMs)
        : false,
    [usePercentScale, totalSeries, totalSamples, fromMs, toMs]
  );
  // Decide switch slot from unfocused state so focusing a zero-capacity pool never shifts the grid.
  const baseSpreadCanRepresent = baseSpread.runs.length > 0 && baseSpread.fullyCovered;
  const showBgSwitch = showProviderCards && baseSpreadCanRepresent;
  const showSpreadBand = usePercentScale && baseSpreadCanRepresent && bgMode === 'smart';
  const showQuietLines = showProviderTraces && !showSpreadBand;
  const plottedLaneSets = showProviderTraces
    ? laneSampleSets.filter((set) => showQuietLines || focusKeys.has(set.key))
    : [];

  // Derive non-% axis extents from all eligible traces so hover/pin emphasis never rescales or
  // shifts horizontal gutters mid-interaction.
  const axisProbeSamples = !usePercentScale
    ? [
        ...(hasTotal ? totalSamples : []),
        ...(showProviderTraces ? laneSampleSets.flatMap((set) => set.visibleSamples) : []),
      ]
    : [];
  const probeAxis = !usePercentScale
    ? chartGeometry(axisProbeSamples, mode, 0, fromMs, toMs)
    : null;
  const pctTicks = axisTicks(0, 100);
  const totalAxisLabel = t('quota_pool.total_points_axis');
  const totalCap = totalSeries?.capacityPoints ?? 0;
  const pctLeftLabels = pctTicks.map((v) => `${number(v)}%`);
  const pctRightLabels =
    !narrow && hasTotal && totalCap > 0
      ? pctTicks.map((pct) => number((pct / 100) * totalCap))
      : [];
  const pctLeftChars = Math.max(1, ...pctLeftLabels.map((s) => s.length));
  const pctRightChars =
    pctRightLabels.length > 0
      ? Math.max(...pctRightLabels.map((s) => s.length), Math.ceil(totalAxisLabel.length * 0.75))
      : 0;
  // Share one memoized 0–100% frame and geometry across axes, traces, and cached spread paths so
  // hovering/leaving a zero-capacity card never discards or duplicates percentage transforms.
  const pctFrame = useMemo(
    () =>
      computeHybridFrame({
        width,
        minimized,
        leftChars: pctLeftChars,
        rightChars: pctRightChars,
      }),
    [width, minimized, pctLeftChars, pctRightChars]
  );
  const pctGeom = useMemo(
    () => chartGeometry([], 'remaining', 100, fromMs, toMs, pctFrame),
    [fromMs, toMs, pctFrame]
  );
  const spreadPaths = useMemo(
    () => buildSpreadPaths(baseSpread.runs, pctGeom.x, pctGeom.y),
    [baseSpread.runs, pctGeom]
  );

  const yTicks = usePercentScale ? pctTicks : axisTicks(probeAxis!.min, probeAxis!.max);
  const leftLabels = usePercentScale ? pctLeftLabels : yTicks.map((v) => number(v));
  const showRightAxis = usePercentScale && pctRightLabels.length > 0;
  const rightLabels = showRightAxis ? pctRightLabels : [];
  const leftChars = usePercentScale
    ? pctLeftChars
    : Math.max(1, ...leftLabels.map((s) => s.length), !narrow ? Math.ceil(unit.length * 0.72) : 0);
  const frame = usePercentScale
    ? pctFrame
    : computeHybridFrame({ width, minimized, leftChars, rightChars: 0 });
  const geom = usePercentScale
    ? pctGeom
    : chartGeometry(axisProbeSamples, mode, 0, fromMs, toMs, frame);
  const { x, y: yOf, segmentRuns } = geom;

  const clearPins = () => {
    setPinnedProviders([]);
    setHoveredProvider(null);
  };

  const stops = useMemo(
    () =>
      buildLaneStops({
        totalSamples,
        laneSamples: laneRawSets.map((s) => s.samples),
        lanes,
        mode,
        fromMs,
        toMs,
        labelOf: laneLabel,
      }),
    [totalSamples, laneRawSets, lanes, mode, fromMs, toMs, laneLabel]
  );
  const latestIdx = latestRecordedStopIndex(stops, nowMs);
  const scrub = useChartScrub({
    stops,
    latestIdx,
    fromMs,
    toMs,
    layoutWidth: frame.width,
    x,
    onEscapeAtRest: activePinned.length > 0 ? clearPins : undefined,
  });
  const activeStop = stops[scrub.activeIndex];
  const committedStop = stops[scrub.committedIndex];
  const { isInspecting, showNowButton } = scrub;

  // Derive empty-state & Projected legend strictly from traces actually plotted on the SVG.
  const hasValues =
    Boolean(hasTotal && plotTotalSamples.some((s) => s.point[field] !== null)) ||
    plottedLaneSets.some((set) => set.plotSamples.some((s) => s.point[field] !== null)) ||
    showSpreadBand;
  const hasProjection =
    Boolean(
      hasTotal &&
      totalSeries &&
      plotTotalSamples.some((s) => s.projected && s.point[field] !== null)
    ) ||
    plottedLaneSets.some((set) =>
      set.plotSamples.some((s) => s.projected && s.point[field] !== null)
    ) ||
    (showSpreadBand && baseSpread.runs.some((run) => run.projected));

  const allTotalTicks = isRemaining ? placeTotalResetTicks(lanes, fromMs, toMs, x, laneLabel) : [];
  const visibleTicks = hasFocus
    ? allTotalTicks.filter((tick) => focusKeys.has(tick.laneKey))
    : allTotalTicks;
  const showMinimizedProviderLegend = minimized && !hasTotal && showProviderTraces;
  const showTickLegend =
    isRemaining &&
    !showMinimizedProviderLegend &&
    (minimized || skipDuplicateLane) &&
    visibleTicks.length > 0;
  const tickLaneKeys = new Set(visibleTicks.map((tick) => tick.laneKey));
  const nextReset = isRemaining ? findNextReset(lanes, nowMs, toMs, laneLabel) : null;
  const allScheduledResets = isRemaining
    ? collectScheduledResets(lanes, fromMs, toMs, laneLabel)
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

  const readoutText = describeCombinedStop({
    stop: committedStop,
    isLatest: scrub.isAtLatestCommit,
    hasTotal,
    lanes,
    unit,
    laneLabel,
    date,
    number,
    labels: {
      inspectHint: t('quota_pool.inspect_hint'),
      latestReading: t('quota_pool.latest_reading'),
      projected: t('quota_pool.projected'),
      total: t('quota_pool.total'),
      noObservation: t('quota_pool.no_observation'),
    },
  });

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

  const totalNormAtActive =
    isRemaining && totalSeries
      ? normalizePercentValue(activeStop?.totalAfter ?? null, totalSeries.capacityPoints)
      : null;

  const togglePinProvider = (key: string) => {
    setPinnedProviders((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]
    );
  };

  const renderOverflowCaret = (
    cx: number,
    cy: number,
    stroke: string,
    key: string,
    extraStyle?: ReturnType<typeof poolProviderStyle>
  ) => (
    <path
      key={key}
      {...extraStyle}
      d={`M${cx - 3.5},${cy - 6.5} L${cx},${cy - 10} L${cx + 3.5},${cy - 6.5}`}
      fill="none"
      stroke={stroke}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-overflow-caret="true"
    />
  );

  const renderProviderTrace = (
    set: (typeof laneSampleSets)[number],
    emphasis: 'quiet' | 'focused'
  ) => {
    if (!set.plotSamples.length) return null;
    const isFocused = emphasis === 'focused';
    const traceOpacity = isFocused ? undefined : hasFocus ? 0.15 : lanes.length <= 4 ? 0.48 : 0.42;
    const strokeWidth = isFocused ? 2.4 : lanes.length <= 4 ? 1.5 : 1.25;
    const overflowXs = set.hasOverflow
      ? overflowMarkerXs(set.visibleSamples, set.lane.capacityPoints, fromMs, toMs, x)
      : [];
    return (
      <g
        key={`${emphasis}-${set.key}`}
        {...poolProviderStyle(set.lane.provider)}
        data-series={set.key}
        data-emphasis={emphasis}
        data-overflow={set.hasOverflow ? 'true' : undefined}
        opacity={traceOpacity}
      >
        <PoolTracePaths
          samples={set.plotSamples}
          mode={mode}
          x={x}
          y={yOf}
          segmentRuns={segmentRuns}
          stroke="var(--pool-accent)"
          strokeWidth={strokeWidth}
          fillId={`${id}-empty-fill`}
          includeProjected={!set.lane.historyOnly}
          showResetRisers
          sparseProjection={set.sparseProjection}
          keyPrefix={`${emphasis}-${set.key}`}
        />
        {overflowXs.map((cx, idx) =>
          renderOverflowCaret(
            cx,
            yOf(100),
            'var(--pool-accent)',
            `${emphasis}-${set.key}-ov-${idx}`
          )
        )}
      </g>
    );
  };

  const totalOverflowXs =
    totalHasOverflow && totalSeries
      ? overflowMarkerXs(totalSamples, totalSeries.capacityPoints, fromMs, toMs, x)
      : [];

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
                    {isRemaining && totalSeries.capacityPoints > 0
                      ? ` / ${number(totalSeries.capacityPoints)}`
                      : `\u00a0${unit}`}
                  </strong>
                  {totalNormAtActive !== null &&
                    ` (${formatNormalizedPercentLabel(totalNormAtActive)})`}
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
                      {`${reset.label}\u00a0+${number(reset.gainPoints)}`}
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
                      .map((item) => `${item.label}\u00a0+${number(item.gainPoints)}`)
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
        data-scale={usePercentScale ? 'percent' : isRemaining ? 'points' : 'rate'}
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
            !isRemaining
              ? 'quota_pool.combined_lanes_rate_description'
              : usePercentScale
                ? 'quota_pool.combined_lanes_description'
                : 'quota_pool.combined_lanes_points_description'
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
              y={frame.top - 12}
              width={frame.right - frame.left + 12}
              height={Math.max(1, frame.bottom - frame.top + 20)}
            />
          </clipPath>
        </defs>

        {!usePercentScale && (
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
            <title>{`${t('quota_pool.total')} (${unit})`}</title>
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

        {/* Shared Y-axis gridlines: fixed 0–100% left (+ exact Total pts right), points fallback, or rates. */}
        {yTicks.map((value, index) => {
          const tickY = yOf(value);
          const isZeroLine = !isRemaining && value === 0 && (probeAxis?.min ?? 0) < 0;
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
          {showSpreadBand && spreadPaths.length > 0 && (
            <g data-spread-band="true" opacity={hasFocus ? 0.45 : 1}>
              {spreadPaths.map((run, runIdx) => (
                <g key={`spread-${runIdx}`} data-spread-projected={run.projected || undefined}>
                  <path d={run.fill} className={styles.spreadBandFill} />
                  <path d={run.upper} className={styles.spreadBandEdge} />
                  <path d={run.lower} className={styles.spreadBandEdge} />
                </g>
              ))}
            </g>
          )}

          {/* Quiet background provider curves below Total. */}
          {showQuietLines &&
            laneSampleSets
              .filter((set) => !focusKeys.has(set.key))
              .map((set) => renderProviderTrace(set, 'quiet'))}

          {/* Bold neutral Total curve. */}
          {hasTotal && totalSeries && (
            <g
              data-series="total"
              data-overflow={totalHasOverflow ? 'true' : undefined}
              opacity={hasFocus ? 0.4 : 1}
            >
              <PoolTracePaths
                samples={plotTotalSamples}
                mode={mode}
                x={x}
                y={yOf}
                segmentRuns={segmentRuns}
                stroke="var(--text-primary)"
                strokeWidth={2.6}
                fillId={hasFocus ? `${id}-empty-fill` : `${id}-total-fill`}
                showResetRisers
                sparseProjection={totalSparseProjection}
                keyPrefix="total"
              />
              {totalOverflowXs.map((cx, idx) =>
                renderOverflowCaret(cx, yOf(100), 'var(--text-primary)', `total-ov-${idx}`)
              )}
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

          {/* Spotlighted / pinned provider curves above Total. */}
          {showProviderTraces &&
            laneSampleSets
              .filter((set) => focusKeys.has(set.key))
              .map((set) => renderProviderTrace(set, 'focused'))}

          {/* Empty-pool markers on the 0 baseline (kept visible so imminent depletions never hide). */}
          {isRemaining &&
            showProviderTraces &&
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
                (!usePercentScale || totalNormAtActive !== null) && (
                  <>
                    <circle
                      cx={x(activeStop.atMs)}
                      cy={yOf(usePercentScale ? totalNormAtActive!.plotPct : activeStop.totalAfter)}
                      r="4.6"
                      fill="var(--text-primary)"
                      stroke="var(--bg-primary)"
                      strokeWidth="2"
                      opacity={hasFocus ? 0.45 : 1}
                      data-overflow={totalNormAtActive?.overflow ? 'true' : undefined}
                    />
                    {usePercentScale &&
                      totalNormAtActive?.overflow &&
                      renderOverflowCaret(
                        x(activeStop.atMs),
                        yOf(100),
                        'var(--text-primary)',
                        'crosshair-total-ov'
                      )}
                  </>
                )}
              {showProviderTraces &&
                laneSampleSets.map((set, index) => {
                  const showDot = focusKeys.has(set.key) || (!hasTotal && showQuietLines);
                  if (!showDot) return null;
                  if (set.lane.historyOnly && activeStop.projected) return null;
                  const val = activeStop.lanes[index];
                  if (!val || val.after === null) return null;
                  const norm = usePercentScale
                    ? normalizePercentValue(val.after, set.lane.capacityPoints)
                    : null;
                  if (usePercentScale && !norm) return null;
                  const yVal = usePercentScale ? norm!.plotPct : val.after;
                  const dotStyle = poolProviderStyle(set.lane.provider);
                  return (
                    <Fragment key={`crosshair-dot-${set.key}`}>
                      <circle
                        {...dotStyle}
                        cx={x(activeStop.atMs)}
                        cy={yOf(yVal)}
                        r="4.5"
                        fill="var(--pool-accent)"
                        stroke="var(--bg-primary)"
                        strokeWidth="1.8"
                        data-overflow={norm?.overflow ? 'true' : undefined}
                      />
                      {norm?.overflow &&
                        renderOverflowCaret(
                          x(activeStop.atMs),
                          yOf(100),
                          'var(--pool-accent)',
                          `crosshair-dot-${set.key}-ov`,
                          dotStyle
                        )}
                    </Fragment>
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
            data-total-reset-lane={tick.laneKey}
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
      {showProviderCards && (
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
          bgSwitchVisible={usePercentScale}
          onSelectBgMode={setBackgroundMode}
          onHoverProvider={setHoveredProvider}
          onTogglePin={togglePinProvider}
          onClearPins={clearPins}
        />
      )}

      <div className={styles.chartFooter}>
        <div className={styles.legend}>
          {showMinimizedProviderLegend &&
            laneSampleSets.map(({ lane, key }) => (
              <span key={`min-prov-${key}`} {...poolProviderStyle(lane.provider)}>
                <i className={styles.providerKey} />
                {laneLabel(lane)}
              </span>
            ))}
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
          <span
            data-style-key
            data-divider={showTickLegend || showMinimizedProviderLegend || undefined}
          >
            <i />
            {t('quota_pool.recorded')}
          </span>
          {hasProjection && (
            <span data-style-key>
              <i className={styles.dashed} />
              {t('quota_pool.projected')}
            </span>
          )}
          {showSpreadBand && (
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
        {readoutText}
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
