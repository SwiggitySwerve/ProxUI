import type { PoolForecastState } from '@/domain/quotaPool/types';

export type PoolChipIcon =
  'check' | 'partial' | 'stale' | 'saved' | 'collecting' | 'info' | 'retired';

/** One chip per card in every state: a word and an icon, each icon used for one status only. */
export function poolChip(
  forecastState: PoolForecastState,
  savedData: boolean,
  retired = false
): {
  state: PoolForecastState | 'saved' | 'retired';
  icon: PoolChipIcon;
  tone: 'neutral' | 'warning';
} {
  // A retired source is no longer read on purpose and has no forecast to save, so nothing about it
  // needs attention, a failed refresh included (the page banner reports that).
  if (retired) return { state: 'retired', icon: 'retired', tone: 'neutral' };
  // Saved data shown during a retry is expected, so its chip stays neutral; the banner explains it.
  if (savedData) return { state: 'saved', icon: 'saved', tone: 'neutral' };
  switch (forecastState) {
    case 'ready':
      return { state: forecastState, icon: 'check', tone: 'neutral' };
    case 'partial':
      return { state: forecastState, icon: 'partial', tone: 'warning' };
    case 'stale':
      return { state: forecastState, icon: 'stale', tone: 'warning' };
    case 'collecting':
      return { state: forecastState, icon: 'collecting', tone: 'neutral' };
    default:
      return { state: forecastState, icon: 'info', tone: 'neutral' };
  }
}
