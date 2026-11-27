import { useTranslation } from 'react-i18next';
import { type CombinedBackgroundMode, type LaneStop, type LaneTrace } from './combinedLanesModel';
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
  onSelectBgMode: (mode: CombinedBackgroundMode) => void;
  onHoverProvider: (key: string | null) => void;
  onTogglePin: (key: string) => void;
  onClearPins: () => void;
}) {
  const { t, i18n } = useTranslation();
  const number = (value: number | null) => formatPoolNumber(value, i18n.language);

  return (
    <div className={styles.providerBarsSection}>
      <div className={styles.providerBarsHeader}>
        <div className={styles.providerBarsMeta}>
          <span>
            {activePinned.length > 0
              ? t('quota_pool.comparing_providers', { count: activePinned.length })
              : t('quota_pool.provider_bars_hint')}
          </span>
          {activePinned.length > 0 && (
            <button type="button" className={styles.providerBarsClear} onClick={onClearPins}>
              {t('quota_pool.clear_pins')}
            </button>
          )}
        </div>
        {showBgSwitch && (
          <div
            className={styles.bgModeSwitch}
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

      <div className={styles.providerBarsGrid}>
        {items.map(({ lane, key }, index) => {
          const stopVal = activeStop?.lanes[index];
          const resetHere = activeStop?.resets.find((r) => r.laneIndex === index);
          const shape = providerMarkerShape(lane.provider);
          const fullName = laneLabel(lane);
          const isPinned = activePinned.includes(key);
          const isDim = hasFocus && !focusKeys.has(key);
          const valueAfter =
            lane.historyOnly && activeStop?.projected ? null : (stopVal?.after ?? null);
          const pct =
            isRemaining && valueAfter !== null && lane.capacityPoints > 0
              ? Math.max(0, Math.min(100, (valueAfter / lane.capacityPoints) * 100))
              : null;
          const isEmpty = isRemaining && !lane.historyOnly && valueAfter === 0;
          const statusTag = lane.historyOnly
            ? t('quota_pool.history_only')
            : lane.forecastState !== 'ready'
              ? t(`quota_pool.state.${lane.forecastState}`)
              : null;
          const primaryMetric = isRemaining
            ? isEmpty
              ? t('quota_pool.empty_short')
              : pct !== null
                ? `${Math.round(pct)}%`
                : '—'
            : valueAfter !== null
              ? `${number(valueAfter)}\u00a0${unit}`
              : '—';
          const subMetric = isRemaining
            ? valueAfter !== null && lane.capacityPoints > 0
              ? `${number(valueAfter)} / ${number(lane.capacityPoints)}`
              : valueAfter !== null
                ? `${number(valueAfter)}\u00a0${unit}`
                : (statusTag ?? t('quota_pool.no_observation'))
            : (statusTag ?? '');

          return (
            <button
              key={key}
              type="button"
              className={`${styles.providerBarCard}${isPinned ? ` ${styles.providerBarPinned}` : ''}${isDim ? ` ${styles.providerBarDim}` : ''}`}
              aria-pressed={isPinned}
              data-provider-card={key}
              data-lane-capacity={lane.capacityPoints}
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
                <span className={isEmpty ? styles.providerBarEmpty : styles.providerBarPct}>
                  {primaryMetric}
                </span>
              </span>
              {isRemaining && (
                <span className={styles.providerBarTrack} aria-hidden="true">
                  <span className={styles.providerBarFill} style={{ width: `${pct ?? 0}%` }} />
                </span>
              )}
              <span className={styles.providerBarSub}>
                <span>{subMetric}</span>
                {resetHere ? (
                  <span className={styles.providerBarGain}>+{number(resetHere.gainPoints)}</span>
                ) : (
                  statusTag &&
                  valueAfter !== null && (
                    <span className={styles.providerBarStatus}>{statusTag}</span>
                  )
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
