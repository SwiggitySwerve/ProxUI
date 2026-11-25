/**
 * The one owner of how a provider looks on every screen: its display name, its ink, and its
 * fill. Fills add a texture to the ink (`src/styles/themes.scss`) because Codex and Gemini are
 * hard to tell apart for colour-blind readers. A provider without a hue stays neutral; each
 * screen picks its own neutral.
 */

/** Display names are proper nouns and stay out of i18n. */
const LABELS: Record<string, string> = {
  gemini: 'Gemini',
  'gemini-interactions': 'Interactions API',
  aistudio: 'AI Studio',
  codex: 'Codex',
  claude: 'Claude',
  devin: 'Devin',
  meta: 'Muse (Meta)',
  xai: 'xAI',
  vertex: 'Vertex AI',
  openai: 'OpenAI Compatible',
  'openai-compatibility': 'OpenAI Compatible',
  qwen: 'Qwen',
  kimi: 'Kimi',
  iflow: 'iFlow',
  antigravity: 'Antigravity',
};

/** A provider's display name; an unknown id is capitalised, and `unknown` is the caller's word. */
export function providerLabel(id: string, unknownLabel: string): string {
  if (id === 'unknown' || !id) return unknownLabel;
  return LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

type ProviderHue = 'claude' | 'codex' | 'gemini';

/** Antigravity serves Gemini models, so it shares the Gemini hue (as Quota always showed it). */
const HUES: Record<string, ProviderHue> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  antigravity: 'gemini',
};

const hue = (id: string | null | undefined): ProviderHue | null => (id ? (HUES[id] ?? null) : null);

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
