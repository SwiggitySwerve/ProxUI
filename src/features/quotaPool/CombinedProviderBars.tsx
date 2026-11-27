import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatNormalizedPercentLabel,
  normalizePercentValue,
  type CombinedBackgroundMode,
  type LaneStop,
  type LaneTrace,
} from './combinedLanesModel';
import { formatPoolNumber } from './presentation';
import { poolProviderStyle, providerGlyphPath, providerMarkerShape } from './providerPresentation';
import styles from './QuotaPoolPage.module.scss';

export interface ProviderBarItem {
  lane: LaneTrace;
  key: string;
}

export function CombinedProviderBars({
  items,
  activeStop,
  isRemaining,
  unit,
  laneLabel,
  activePinned,
  focusKeys,
  hasFocus,
  bgMode,
  showBgSwitch,
  bgSwitchVisible = true,
  onSelectBgMode,
  onHoverProvider,
  onTogglePin,
  onClearPins,
}: {
  items: readonly ProviderBarItem[];
  activeStop: LaneStop | undefined;
  isRemaining: boolean;
  unit: string;
  laneLabel: (lane: LaneTrace) => string;
  activePinned: readonly string[];
  focusKeys: ReadonlySet<string>;
  hasFocus: boolean;
  bgMode: CombinedBackgroundMode;
  showBgSwitch: boolean;
  /** Reserves row height while hiding the switch during temporary points fallback. */
  bgSwitchVisible?: boolean;
  onSelectBgMode: (mode: CombinedBackgroundMode) => void;
  onHoverProvider: (key: string | null) => void;
  onTogglePin: (key: string) => void;
  onClearPins: () => void;
}) {
  const { t, i18n } = useTranslation();
  const gridRef = useRef<HTMLDivElement>(null);
  const clearButtonRef = useRef<HTMLButtonElement>(null);
  const number = (value: number | null) => formatPoolNumber(value, i18n.language);
  const hasPins = activePinned.length > 0;

  const handleClearPins = () => {
    onClearPins();
    gridRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  };

  return (
    <div
      className={styles.providerBarsSection}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && hasPins) {
          event.preventDefault();
          if (document.activeElement === clearButtonRef.current) {
            handleClearPins();
          } else {
            onClearPins();
          }
        }
      }}
    >
      <div className={styles.providerBarsHeader}>
        <div className={styles.providerBarsMeta}>
          <span>
            {hasPins
              ? t('quota_pool.comparing_providers', { count: activePinned.length })
              : t('quota_pool.provider_bars_hint')}
          </span>
          <button
            ref={clearButtonRef}
            type="button"
            className={
              hasPins
                ? styles.providerBarsClear
                : `${styles.providerBarsClear} ${styles.providerBarsClearHidden}`
            }
            aria-hidden={!hasPins || undefined}
            tabIndex={hasPins ? 0 : -1}
            onClick={handleClearPins}
          >
            {t('quota_pool.clear_pins')}
          </button>
        </div>
        {showBgSwitch && (
          <div
            className={
              bgSwitchVisible
                ? styles.bgModeSwitch
                : `${styles.bgModeSwitch} ${styles.bgModeSwitchHidden}`
            }
            role="group"
            aria-label={t('quota_pool.background_style_label')}
          >
            <button
              type="button"
              aria-pressed={bgMode === 'smart'}
              title={t('quota_pool.background_smart_hint')}
              onClick={() => onSelectBgMode('smart')}
            >
              {t('quota_pool.background_smart')}
            </button>
            <button
              type="button"
              aria-pressed={bgMode === 'ghost'}
              title={t('quota_pool.background_ghost_hint')}
              onClick={() => onSelectBgMode('ghost')}
            >
              {t('quota_pool.background_ghost')}
            </button>
          </div>
        )}
      </div>

      <div className={styles.providerBarsGrid} ref={gridRef}>
        {items.map(({ lane, key }, index) => {
          const stopVal = activeStop?.lanes[index];
          const resetHere = activeStop?.resets.find((r) => r.laneIndex === index);
          const shape = providerMarkerShape(lane.provider);
          const fullName = laneLabel(lane);
          const isPinned = activePinned.includes(key);
          const isDim = hasFocus && !focusKeys.has(key);
          const valueAfter =
            lane.historyOnly && activeStop?.projected ? null : (stopVal?.after ?? null);
          const hasCap = lane.capacityPoints > 0;
          const norm = isRemaining ? normalizePercentValue(valueAfter, lane.capacityPoints) : null;
          const isEmpty = isRemaining && !lane.historyOnly && valueAfter === 0;
          const statusTag = lane.historyOnly
            ? t('quota_pool.history_only')
            : lane.forecastState !== 'ready'
              ? t(`quota_pool.state.${lane.forecastState}`)
              : null;
          // Keep zero-capacity balances on the sub-row so provider names never truncate on narrow phones.
          const primaryMetric = isRemaining
            ? isEmpty
              ? t('quota_pool.empty_short')
              : norm
                ? formatNormalizedPercentLabel(norm)
                : hasCap
                  ? '—'
                  : ''
            : valueAfter !== null
              ? `${number(valueAfter)}\u00a0${unit}`
              : '—';
          const showCapacityTrack = isRemaining && hasCap;
          const subMetric = isRemaining
            ? valueAfter !== null && hasCap
              ? `${number(valueAfter)} / ${number(lane.capacityPoints)}`
              : valueAfter !== null
                ? `${number(valueAfter)}\u00a0${unit}`
                : (statusTag ?? t('quota_pool.no_observation'))
            : (statusTag ?? '');
          const showSubRow = Boolean(subMetric || resetHere || (statusTag && valueAfter !== null));

          return (
            <button
              key={key}
              type="button"
              className={`${styles.providerBarCard}${isPinned ? ` ${styles.providerBarPinned}` : ''}${isDim ? ` ${styles.providerBarDim}` : ''}`}
              aria-pressed={isPinned}
              data-provider-card={key}
              data-lane-capacity={lane.capacityPoints}
              data-overflow={norm?.overflow ? 'true' : undefined}
              {...poolProviderStyle(lane.provider)}
              onPointerEnter={(event) => {
                if (event.pointerType === 'mouse') onHoverProvider(key);
              }}
              onPointerLeave={(event) => {
                if (event.pointerType === 'mouse') onHoverProvider(null);
              }}
              onClick={() => onTogglePin(key)}
            >
              <span className={styles.providerBarTop}>
                <span className={styles.providerBarName} title={fullName}>
                  <svg
                    width="9"
                    height="9"
                    viewBox="0 0 9 9"
                    aria-hidden="true"
                    className={styles.providerBarGlyph}
                  >
                    <path d={providerGlyphPath(shape, 4.5, 4.5, 3.6)} fill="var(--pool-accent)" />
                  </svg>
                  <span data-provider-label="true">{fullName}</span>
                </span>
                {primaryMetric && (
                  <span
                    className={isEmpty ? styles.providerBarEmpty : styles.providerBarPct}
                    data-overflow={norm?.overflow ? 'true' : undefined}
                  >
                    {primaryMetric}
                  </span>
                )}
              </span>
              {showCapacityTrack && (
                <span className={styles.providerBarTrack} aria-hidden="true">
                  <span
                    className={styles.providerBarFill}
                    data-overflow={norm?.overflow ? 'true' : undefined}
                    style={{ width: `${norm?.plotPct ?? 0}%` }}
                  />
                </span>
              )}
              {showSubRow && (
                <span
                  className={styles.providerBarSub}
                  data-has-status={
                    Boolean(!resetHere && statusTag && valueAfter !== null) || undefined
                  }
                >
                  <span data-provider-submetric="true">{subMetric}</span>
                  {resetHere ? (
                    <span className={styles.providerBarGain}>+{number(resetHere.gainPoints)}</span>
                  ) : (
                    statusTag &&
                    valueAfter !== null && (
                      <span className={styles.providerBarStatus}>{statusTag}</span>
                    )
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
