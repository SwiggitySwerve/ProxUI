import type { CSSProperties } from 'react';
import type { TFunction } from 'i18next';
import { isBuiltInPoolProvider } from '@/domain/quotaPool/providers';
import type { AccountQuotaWindow } from '@/domain/quotaPool/types';
import { providerInk } from '@/features/providers/identity';

export function poolProviderLabel(t: TFunction, provider: string, displayName?: string): string {
  return isBuiltInPoolProvider(provider) || (provider === 'all' && !displayName)
    ? t(`quota_pool.${provider}`)
    : (displayName ?? provider);
}

export function poolProviderStyle(provider: string) {
  const ink = providerInk(provider);
  if (ink) return { style: { '--pool-accent': ink } as CSSProperties };
  let hash = 0;
  for (const character of provider) hash = Math.imul(hash, 31) + character.charCodeAt(0);
  return { style: { '--pool-accent': `hsl(${(hash >>> 0) % 360} 58% 65%)` } as CSSProperties };
}

export type ProviderMarkerShape = 'triangle' | 'diamond' | 'square' | 'circle';

const BUILT_IN_SHAPES: Record<string, ProviderMarkerShape> = {
  claude: 'triangle',
  codex: 'diamond',
  gemini: 'square',
  antigravity: 'square',
};
const FALLBACK_SHAPES: readonly ProviderMarkerShape[] = ['triangle', 'diamond', 'square', 'circle'];

/** Deterministic non-colour shape so Codex blue and Gemini purple remain distinguishable under CVD. */
export function providerMarkerShape(provider: string): ProviderMarkerShape {
  if (Object.prototype.hasOwnProperty.call(BUILT_IN_SHAPES, provider)) {
    return BUILT_IN_SHAPES[provider];
  }
  let hash = 0;
  for (const character of provider) hash = Math.imul(hash, 31) + character.charCodeAt(0);
  return FALLBACK_SHAPES[(hash >>> 0) % FALLBACK_SHAPES.length];
}

/** SVG path data for a small centred marker glyph. */
export function providerGlyphPath(
  shape: ProviderMarkerShape,
  cx: number,
  cy: number,
  r: number
): string {
  const n = (v: number) => Math.round(v * 10) / 10;
  if (shape === 'triangle') {
    return `M${n(cx - r)},${n(cy + r * 0.8)} L${n(cx)},${n(cy - r)} L${n(cx + r)},${n(cy + r * 0.8)} Z`;
  }
  if (shape === 'diamond') {
    return `M${n(cx)},${n(cy - r)} L${n(cx + r)},${n(cy)} L${n(cx)},${n(cy + r)} L${n(cx - r)},${n(cy)} Z`;
  }
  if (shape === 'square') {
    const s = r * 0.85;
    return `M${n(cx - s)},${n(cy - s)} H${n(cx + s)} V${n(cy + s)} H${n(cx - s)} Z`;
  }
  return `M${n(cx - r)},${n(cy)} A${n(r)},${n(r)} 0 1,0 ${n(cx + r)},${n(cy)} A${n(r)},${n(r)} 0 1,0 ${n(cx - r)},${n(cy)} Z`;
}

export function quotaWindowLabel(t: TFunction, window: AccountQuotaWindow): string {
  return window.label ?? t(window.labelKey, window.labelParams);
}
