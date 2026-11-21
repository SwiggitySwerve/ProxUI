import { isValidProviderId } from '@/domain/providerCatalog';
import { poolProviderViewId } from '@/domain/quotaPool/providers';
import type { PoolDashboard, QuotaPool } from '@/domain/quotaPool/types';
import type { ChartMode } from '../chartGeometry';

/**
 * The page's view, kept in the address so a copied link opens the same view. The date offset
 * stays out (it is relative to today, so a shared link would drift), and so does "Show emails".
 */
export interface QuotaViewState {
  provider: string;
  window: PoolDashboard['window'];
  mode: ChartMode;
  lookback: PoolDashboard['lookbackHours'];
  future: PoolDashboard['multiplier'];
}

export const DEFAULT_VIEW_STATE: QuotaViewState = {
  provider: 'all',
  window: 'weekly',
  mode: 'remaining',
  lookback: 3,
  future: 1,
};

type Filter = Exclude<keyof QuotaViewState, 'provider'>;
const ALLOWED: { [K in Filter]: readonly QuotaViewState[K][] } = {
  window: ['weekly', 'five-hour'],
  mode: ['remaining', 'drain', 'burn'],
  lookback: [1, 3, 6],
  future: [1, 0.5, 2, 0],
};

const KEYS = Object.keys(DEFAULT_VIEW_STATE) as (keyof QuotaViewState)[];

/** Each key is matched against its allowed values; anything else falls back to the default. */
export function readViewState(params: URLSearchParams): QuotaViewState {
  const pick = <K extends Filter>(key: K): QuotaViewState[K] => {
    const raw = params.get(key);
    return (
      (ALLOWED[key] as readonly QuotaViewState[K][]).find((value) => String(value) === raw) ??
      DEFAULT_VIEW_STATE[key]
    );
  };
  const provider = params.get('provider');
  return {
    provider:
      isValidProviderId(provider) || provider === poolProviderViewId('all')
        ? provider
        : DEFAULT_VIEW_STATE.provider,
    window: pick('window'),
    mode: pick('mode'),
    lookback: pick('lookback'),
    future: pick('future'),
  };
}

/** Writes non-default values only, so the plain address stays canonical; other parameters stay. */
export function writeViewState(previous: URLSearchParams, view: QuotaViewState): URLSearchParams {
  const next = new URLSearchParams(previous);
  KEYS.forEach((key) => {
    if (view[key] === DEFAULT_VIEW_STATE[key]) next.delete(key);
    else next.set(key, String(view[key]));
  });
  return next;
}

export function sameView(a: QuotaViewState, b: QuotaViewState): boolean {
  return KEYS.every((key) => a[key] === b[key]);
}

/** Keep the legacy chips first; append the providers with pools on any source. */
export function visibleProviders(
  pools: readonly Pick<QuotaPool, 'provider'>[] | undefined
): readonly QuotaViewState['provider'][] {
  const discovered = (pools ?? [])
    .map((pool) => pool.provider)
    .filter(isValidProviderId)
    .sort();
  return [...new Set(['all', 'claude', 'codex', ...discovered.map(poolProviderViewId)])];
}

/** Fall back to `all` when a deep-linked provider is absent from the available choices. */
export function resolveViewProvider(
  provider: QuotaViewState['provider'],
  available: readonly QuotaViewState['provider'][]
): QuotaViewState['provider'] {
  return available.includes(provider) ? provider : 'all';
}
