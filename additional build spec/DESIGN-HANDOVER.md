# Design handover

Companion to `trivia-design-system.html`. Open that file, click through the rail, and toggle
the light theme — every screen recolours from nine variables and nothing else.

This document is what Claude Code needs. Put it in `docs/` and reference it from `CLAUDE.md`.

---

## 1. The direction, in one paragraph

A pub trivia night: dim room, brass lamps, a scoreboard on the wall. Not a SaaS dashboard.
**Ink-blue base rather than neutral black**, warm brass accent rather than acid green. One
typeface — Archivo variable — where **width encodes role**: narrow uppercase for labels,
normal for body, expanded black for display. **Every element is a tile on a board**: answer
options, leaderboard rows, marking queue rows, the table tally. That vernacular is the
signature and it should not be diluted with cards, panels or other container metaphors.

---

## 2. Extract the CSS as-is

The `<style>` block in the design system file is the shipped stylesheet, minus the page
chrome. Split it:

```
src/public/css/tokens.css      ← :root, [data-theme="light"], primitives
src/public/css/components.css  ← .tile, .btn, .field, .status, .band, .vitals, .tally, .lb, .notice
```

Everything from `/* ---------- page chrome ---------- */` onwards in the second `<style>`
block is the demo harness. **Do not ship it**, apart from `.pbody`, `.cbody`, `.sbody`, the
`.s-*` big screen rules and `.bigscreen` container query setup, which are real layout.

No build step, no framework, no CSS preprocessor. This is deliberate and already an
invariant.

---

## 3. Theming — the contract

```css
:root {
  --bg: #10151F;  --bg2: #17202E;  --surface: #1B2432;  --surface-selected: #2D3B50;
  --text: #F2F0EA;  --text-muted: #8D98A8;  --border: #2E3A4C;
  --accent: #E8A33D;  --accent-text: #16191C;
}
```

**Those nine are the only values a theme may set.** `--correct`, `--wrong`, `--pending`,
every spacing value, every radius and the whole type scale are fixed and never themed.

Server-side, resolve the cascade (question → round → event) into a flat set of nine and emit
them on the document element:

```html
<html style="--bg:#2A1A3E;--bg2:#160E24;--accent:#E8A33D; ...">
```

The client never sees the cascade. One resolution, one place to test.

**Derivation rule for a preset that only sets `--bg` and `--accent`:**

| Token | Derived as |
|---|---|
| `--surface` | bg mixed 10% toward white if dark, 6% toward black if light |
| `--surface-selected` | bg mixed 22% / 14% the same way |
| `--text` | `#F2F0EA` on dark, `#16191C` on light |
| `--text-muted` | text mixed 45% toward bg |
| `--border` | bg mixed 24% / 20% |
| `--accent-text` | whichever of near-black or near-white has more contrast against accent |

Compute these at save time in admin, store the resolved nine, validate, and serve. Don't
compute in the browser.

---

## 4. Typography

```html
<link href="https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@0,62..125,400..900&display=swap" rel="stylesheet">
```

**Self-host it before the event.** A blocking webfont on a bad venue connection means a blank
question. `font-display: swap` and a system stack fallback are both non-negotiable.

Width axis usage — this is the whole typographic system, so don't reach for a second family:

| Class | `wdth` | Used for |
|---|---|---|
| `.label` | 62, uppercase, `.14em` tracking | Eyebrows, vitals keys, table numbers, status |
| *(default)* | 100 | Prompts, options, body, inputs |
| `.display` | 125, weight 800 | Big screen prompts, scores, leaderboard positions |

`.num` applies tabular figures. Use it on every score, count, timer and table number so
digits don't shuffle as they change.

---

## 5. Component inventory

| Class | What it is | Notes |
|---|---|---|
| `.tile` | The base unit | `.seated` = selected, `.flat` = non-interactive, `[disabled]` |
| `.chip` | Letter badge inside a tile | Inverts when seated |
| `.btn` | `.ghost` `.danger` `.sm` `.wide` | Accent-filled is the primary action, one per screen |
| `.field` | Text input | 44px min, 16px text |
| `.status` | `.ok` `.bad` `.wait` | Shape + word + colour, never colour alone |
| `.band` | Team colour header | Phone only, identity, constant all night |
| `.vitals` / `.vital` | Operator strip | Always visible on operator surfaces |
| `.tally` | 30 lozenges | `.in` answered, `.out` in trouble, `.us` your table |
| `.lb` / `.lb-row` | Leaderboard | `.lead` for first, `.swatch` for team colour |
| `.notice` | Inline message | `.ok` `.bad` variants |

### The seated state matters more than it looks

A selected answer carries **four** signals: inset shadow, 2px border in `--text`, weight 700,
and an inverted chip. None is colour. That's what makes it survive every theme in the palette
and every kind of colour vision.

When you build it, keep the padding compensation — `.seated` reduces padding by 1px to
offset the thicker border, so tiles don't jump on selection.

---

## 6. Layouts

Layout is a **named intent rendered natively per surface**, never a shared geometry.

| Layout | Big screen | Phone |
|---|---|---|
| `standard` | Prompt 4.8cqw, options 2×2 | Prompt, stacked option tiles |
| `image` | Image and prompt side by side | Image full width, prompt below, options stacked |
| `media` | Title only, no prompt while the clip plays | "Listen up" holding card |
| `statement` | Prompt 6.4cqw, no options | Prompt large, input below |
| `text-answer` | Prompt large, no options | Prompt, then input field |

**Big screen type is in `cqw` units** against `container-type: inline-size`, so it scales with
the projector rather than assuming a resolution. Don't convert these to `rem`.

---

## 7. Non-negotiables

These come from decisions already made in `technical-design.md`. Breaking one is a
regression, not a style preference.

1. **16px minimum body text on phones.** Below that, iOS zooms the viewport on input focus.
2. **44px minimum tap targets.** Dark room, drinks, moving hands.
3. **Never colour alone** for selected, correct, wrong or unanswered.
4. **Team colour never touches the content area** — header band, leaderboard swatch and
   printed card only. Never a row background.
5. **Focus rings are visible** — 3px accent, 2px offset. Operators use keyboards.
6. **`prefers-reduced-motion` kills every transition.** Already in the stylesheet.
7. **Escape all user content.** Team names and free-text answers reach the projector. Use
   `textContent`, never `innerHTML`.
8. **Big screen contrast at 7:1**, phone at 4.5:1. Projection loses contrast to ambient light.
9. **No pure black and no pure white.** A projector renders black as room light; pure white
   blooms.
10. **Re-render only on version change, never over a focused subtree.**

---

## 8. Screen-by-screen implementation notes

**Player gate** — `autocapitalize="off"` and `autocorrect="off"` on the passphrase field.
People are typing two words off a projector in the dark.

**Pick name** — the list is per table, not per device. The captain badge is a `.label` inside
the tile, not a separate colour.

**Question, captain** — the confirmation notice is timestamped and always present once an
answer exists. It's how the table sees the answer landed without leaning over.

**Question, following along** — options are `.tile.flat`, not `[disabled]`. They are
information, not broken controls. Takeover is a `.btn.ghost.wide` in the main flow, never
behind a menu.

**Paused** — the question is *absent from the DOM*, not hidden with CSS. Anything in the DOM
can be read. Preserve the input draft in client state.

**Big screen** — `.s-foot` reduces the content area; layouts must lay out above it. The
statement layout at 6.4cqw will run under a sponsor strip otherwise.

**Host console** — every action has a `<kbd>`. Space advances, C closes, R reveals, B bonus,
P pause. A presentation clicker should run the night.

**Marker** — one answer at a time at display size. Y / N / A keys. The correct answer stays
on screen throughout the sweep.

**Floor** — phone frame, and **no correct answers anywhere on this surface**. That screen is
readable over a shoulder in a crowded room.

---

## 9. What to build first

The design system file covers every screen, but build in the P0 order already in
`CLAUDE.md`. For each slice:

1. Extract only the components that slice needs
2. Match the design system screen exactly, including spacing
3. Check it on a real phone through the tunnel before moving on

**Don't build a component library up front.** The tile, the button, the field and the status
indicator cover roughly 80% of every screen here — start with those four and add the rest as
slices need them.

---

## 10. Add to CLAUDE.md

```markdown
## Design

Implementation reference: `docs/DESIGN-HANDOVER.md`, mockups in
`docs/trivia-design-system.html`.

One typeface (Archivo variable) where width encodes role: 62 narrow for labels, 100 for body,
125 weight 800 for display. Every element is a tile on a board — do not introduce card, panel
or accordion metaphors.

Nine theme tokens are the only overridable values. Everything else is fixed. Resolve the
cascade server-side and emit the resolved nine on the document element.

Selected, correct, wrong and unanswered are signalled by shape, weight and words as well as
colour — never colour alone. 16px minimum body text, 44px minimum targets, visible focus
rings, reduced motion respected.
```
