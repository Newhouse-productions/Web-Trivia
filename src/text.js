// Length caps for user-supplied text, applied at the API (CLAUDE.md #2).
// Counted in characters, not UTF-16 units: String#slice can cut an emoji
// in half and store a broken character that then shows on the projector.
export function capText(value, max, { trim = true } = {}) {
  let s = String(value ?? '');
  if (trim) s = s.trim();
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') : s;
}
