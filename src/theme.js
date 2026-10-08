// Theme cascade: question overrides round overrides event default, per
// property, like CSS (CLAUDE.md #19, #21). Colour tokens are derived from
// bg/bg2/accent using the same WCAG-luminance algorithm as
// Mockups/trivia-theme-mockup.html, so the admin preview and the actual
// render agree. Resolve and validate server-side; the client never sees
// the cascade (CLAUDE.md #21).
const LAYOUTS = ['standard', 'image', 'media', 'statement', 'text-answer'];
const CASCADE_PROPS = ['layout', 'bg', 'bg2', 'accent'];

const DEFAULT_COLOUR = { bg: '#1A1D24', bg2: '#2A2F3A', accent: '#E0A82E' };
const DEFAULT_LAYOUT = 'standard';

function normalizeHex(hex) {
  let h = String(hex || '').trim().toLowerCase().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return `#${h}`;
}

function hex2rgb(hex) {
  hex = normalizeHex(hex);
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex) {
  const c = hex2rgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrastRatio(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a, b, t) {
  const A = hex2rgb(a);
  const B = hex2rgb(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

export const isDark = (hex) => luminance(hex) < 0.35;

// Sensible values derived from bg + accent when a preset doesn't specify
// them (CLAUDE.md #19) — real tokens with real fallbacks, not guesses made
// at render time.
export function deriveTokens(colour) {
  const bg = colour.bg || DEFAULT_COLOUR.bg;
  const bg2 = colour.bg2 || bg;
  const accent = colour.accent || DEFAULT_COLOUR.accent;
  const dark = isDark(bg);
  const text = colour.text || (dark ? '#F5F5F0' : '#16191C');
  const textMuted = colour['text-muted'] || (dark ? mix(text, bg, 0.45) : mix(text, bg, 0.4));
  const surface = colour.surface || (dark ? mix(bg, '#FFFFFF', 0.10) : mix(bg, '#000000', 0.06));
  const surfaceSelected = colour['surface-selected'] || (dark ? mix(bg, '#FFFFFF', 0.22) : mix(bg, '#000000', 0.14));
  const border = colour.border || (dark ? mix(bg, '#FFFFFF', 0.24) : mix(bg, '#000000', 0.20));
  const accentText = colour['accent-text'] ||
    (contrastRatio(accent, '#16191C') > contrastRatio(accent, '#F5F5F0') ? '#16191C' : '#F5F5F0');

  return { bg, bg2, surface, 'surface-selected': surfaceSelected, text, 'text-muted': textMuted, border, accent, 'accent-text': accentText };
}

// Per-property cascade: question > round > event (CLAUDE.md #19, #21).
export function resolveTheme({ eventTheme, roundTheme, questionTheme }) {
  const layers = [questionTheme || {}, roundTheme || {}, eventTheme || {}];
  const merged = {};
  for (const prop of CASCADE_PROPS) {
    for (const layer of layers) {
      if (layer[prop] !== undefined) { merged[prop] = layer[prop]; break; }
    }
  }
  const layout = LAYOUTS.includes(merged.layout) ? merged.layout : DEFAULT_LAYOUT;
  const colour = deriveTokens({ bg: merged.bg, bg2: merged.bg2, accent: merged.accent });
  // Fixed correct/wrong/pending colours have separate dark/light variants
  // (design-system tokens.css) and must never be derived from the theme's
  // own bg/accent — the client picks the right pair from this flag alone.
  return { layout, colour, dark: isDark(colour.bg) };
}

// Contrast validated at 7:1 for projection, 4.5:1 for phone token pairs
// (CLAUDE.md #19, #22) — ambient light, a dusty lens and a cheap screen all
// subtract, so the projector bar is stricter than the phone's.
export function validateContrast(colour) {
  const checks = [
    { label: 'Projector · text on bg', a: colour.text, b: colour.bg, required: 7 },
    { label: 'Projector · accent on bg', a: colour.accent, b: colour.bg, required: 7 },
    { label: 'Phone · text on surface', a: colour.text, b: colour.surface, required: 4.5 },
    { label: 'Phone · muted on bg', a: colour['text-muted'], b: colour.bg, required: 4.5 },
    { label: 'Phone · accent-text on accent', a: colour['accent-text'], b: colour.accent, required: 4.5 }
  ].map((c) => {
    const ratio = contrastRatio(c.a, c.b);
    return { ...c, ratio: Math.round(ratio * 10) / 10, pass: ratio >= c.required };
  });
  // No pure black (a projector renders it as room light) and no pure white
  // (it blooms) on the big screen (CLAUDE.md #22).
  for (const [label, value] of [['background', colour.bg], ['background 2', colour.bg2], ['text', colour.text]]) {
    const hex = normalizeHex(value);
    if (hex === '#000000' || hex === '#ffffff') {
      checks.push({
        label: `Projector · ${label} is pure ${hex === '#000000' ? 'black' : 'white'}`,
        a: value, b: null, required: null, ratio: null, pass: false
      });
    }
  }
  return { pass: checks.every((c) => c.pass), checks };
}

export { LAYOUTS };
