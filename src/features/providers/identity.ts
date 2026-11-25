/**
 * The one owner of a provider's colour on every screen: its ink, and its fill for bars. Fills add
 * a texture to the ink (`src/styles/themes.scss`) because Codex and Gemini are hard to tell apart
 * for colour-blind readers. A provider without a hue stays neutral; each screen picks its own
 * neutral. Names are not owned here: Analytics shows prox-usage's labels, and Quota names the
 * Antigravity pool Gemini on purpose.
 */

type ProviderHue = 'claude' | 'codex' | 'gemini';

/** Antigravity serves Gemini models, so it shares the Gemini hue (as Quota always showed it). */
const HUES: Record<string, ProviderHue> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  antigravity: 'gemini',
};

const hue = (id: string | null | undefined): ProviderHue | null =>
  id && Object.prototype.hasOwnProperty.call(HUES, id) ? HUES[id] : null;

/** Flat colour for dots, strokes and text accents. Null: the caller's neutral. */
export const providerInk = (id: string | null | undefined): string | null => {
  const h = hue(id);
  return h ? `var(--${h}-color)` : null;
};

/** Colour plus texture for filled areas such as bars. Null: the caller's neutral. */
export const providerFill = (id: string | null | undefined): string | null => {
  const h = hue(id);
  return h ? `var(--${h}-fill)` : null;
};
