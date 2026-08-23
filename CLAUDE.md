# CLAUDE.md

Trivia night app. 30 tables, ~240 phones, three hours, no chance to debug live.
Multi-event capable: many configured, exactly one active at a time.

Full spec lives in `docs/scope.md` and `docs/technical-design.md`. Read both before changing
architecture. This file holds the invariants that are easy to break by accident.

---

## Non-negotiables

These are load-bearing. If a change appears to require breaking one, stop and ask.

**1. Player payloads are built from an allowlist, never by deletion.**
Never send `correct_answer`, `aliases`, future questions, other tables' answers, or unopened
media to a player. Build the response by naming the fields to include. Deleting sensitive
fields from a row is one forgotten column away from leaking the whole quiz, and anyone can
open dev tools on their own phone.

**2. Escape every user value, and never `innerHTML` one.**
Team names, usernames and free-text answers render on the operator console and the
projector. Use `textContent`. CSP is `default-src 'self'` with `frame-src` limited to
youtube-nocookie. Cap lengths at the API, not the input field.

**3. Never store an absolute URL. Build every URL from the incoming request.**
The database holds tokens, never links. The QR sheet and the big screen's join instructions
render from the current host at request time. Development runs on a quick Cloudflare Tunnel
whose hostname changes on every restart, so a stored URL is wrong within a day — and this is
also what makes the eventual move to a real domain free.

**4. The table token is exchanged once, then never in a URL.**
`/t/:token` sets the session cookie and 302s to `/play`. Every later request identifies the
table from the cookie. A token in a path leaks to YouTube via `Referer` and into Cloudflare
and Caddy access logs. `Referrer-Policy: no-referrer` globally.

**5. Version is `max(event_version, table_version)`.**
A bonus at table 4 must not make 240 devices fetch a snapshot. Increment atomically inside
the same transaction as the change — `UPDATE ... SET version = version + 1 RETURNING
version`, never read-then-write.

**6. `event_id` is on every table and in every query.**
Many events can be configured; exactly one is `active`. Never write a query that assumes a
single event, even now. Player and screen URLs carry no event — tokens are globally unique
and resolve to one. PINs and the passphrase are per event. Config JSON import always creates
a **new** event and always regenerates tokens and PINs; it never overwrites.

**7. Marking is a live queue, not a round-end batch.**
A free-text question entering `CLOSED` lands in the marker's queue immediately and is worked
during play. Free text can be `REVEALED` while still unmarked — the room hears the answer,
the table's own result says "scored at the end of the round". Do not reintroduce a `MARKED`
state between `CLOSED` and `REVEALED`. Marking must finish before the round publishes.

**Reopening a marked question re-queues only the tables whose answers then change.** Never
invalidate the whole question's marks, and warn the host before reopening.

**8. Commands are absolute, never relative.**
`setQuestion(id, state)` — never `next()`, `close()`, `toggleMark()`. Two hosts pressing the
same button, a double-tap, or a retry must all produce the same result. Every state-changing
request carries `expects_version` and is rejected with 409 if stale.

**9. Never patch, always snapshot.**
Clients poll for a version integer and refetch whole state when it moves. No deltas, no
event replay. A phone that missed six changes must end up identical to one that just
scanned.

**10. Rate limit in two layers, never per IP.**
240 phones share one NAT address, so per-IP limiting locks out the whole room the first time
a dozen people mistype the passphrase. Per session for honest errors; a global per-role
counter with lockout for actual attacks, because discarding a cookie defeats per-session
limiting entirely.

**11. SQLite runs in WAL mode.**
`journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`. Without
WAL a single write blocks every reader, which is visible at 80 polls/second.

**12. One answer per table, written only by the captain.**
Reject any submission from a non-captain, and any submission for a question not `OPEN`.
Captaincy auto-assigns to the first player to open a table's page — a table with no captain
cannot answer at all, and nobody notices until the scores look wrong. Takeover is one tap
from any non-captain screen and must stay in the main flow, never behind a menu.

**13. Scores are derived, never stored.**
Computed from `answers` + `bonuses` on read. There is no running total to corrupt.

**14. Never re-score silently.**
Editing a question that has been marked or revealed changes scores the room has already
seen. Always show an impact preview counted in tables and points, require confirmation, and
log it. Editing a question while it is `OPEN` is blocked outright.

**15. Re-render only on version change, and never over focus.**
The snapshot architecture must not be implemented as `innerHTML = render(state)` on the
player page. An unchanged poll touches nothing; a changed one leaves any focused subtree
alone and announces the change through an `aria-live="polite"` region. Otherwise screen
reader users lose focus every three seconds and cannot type an answer at all.

**16. Never colour alone, and never an image without a description.**
Correct and wrong carry an icon and a word. Image questions require authored alt text that
describes without naming the answer.

**17. Pause is a flag on the event, not a state.**
It overlays whatever is happening and resumes to exactly that. Hides the question, rejects
player writes, stops the timer — but marking, floor and admin keep working. **Never clear a
captain's typed draft on a paused response.**

**18. Team colour is an identifier. The theme is everything else.**
`teams.colour` is one solid or gradient, used for the phone header band, the printed card, a
leaderboard swatch and the floor grid. It is not a theme and is never called one. It never
touches the content area.

**19. One theme, both surfaces, carrying layout and colour.**
The resolved theme paints the big screen and the phone's content area together — a music
round darkens both and switches both to the `media` layout. Layout is a **named intent**
(`standard`, `image`, `media`, `statement`, `text-answer`) rendered natively per surface,
never a shared geometry: a projector is 16:9 at 30 metres, a phone is portrait at arm's
length.

Colour is a token set (`bg`, `surface`, `surface-selected`, `text`, `text-muted`, `border`,
`accent`, `accent-text`), not two values — a phone has inputs and buttons a projector
doesn't. Validate resolved themes at 7:1 for projection **and** 4.5:1 for phone token pairs.

**20. Chrome is set once and does not cascade.**
Logo and footer band are event-level only. Their colour follows the resolved theme, their
position does not change, and **the footer band reduces the content area rather than
overlapping it** — or the statement layout runs its prompt under the sponsor's name. Two
logo variants, picked by resolved background luminance.

**21. Resolve the theme cascade server-side and validate the resolved result.**
Question overrides round overrides event default, **per property** like CSS. A round that
changes only the background inherits an accent that may fail against it — neither layer
fails alone, the resolved theme does. Validate all 30 resolved combinations at save; refuse
to activate an event with a failing one. The client receives a resolved theme, never a
cascade.

**22. The big screen is validated at 7:1, not 4.5:1.**
Projection loses contrast to ambient light. No pure black (a projector renders it as room
light), no pure white (it blooms), no text over a background image. Preview at back-of-room
scale, not laptop scale.

**23. Markers claim a whole question, not individual rows.**
Because "accept this spelling for all tables" rewrites the alias list and re-scores every
other table. Two markers on one question is the worst available bug.

---

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

---

## Stack — hold the line

Node LTS · Fastify · `better-sqlite3` · no frontend framework · no build step · Caddy ·
systemd.

Three separate pages sharing a stylesheet and a poll helper: `/t/:token` (player), `/ops`
(console), `/screen` (big screen). Each has one `render(state)` function that redraws from a
snapshot.

**Resist adding dependencies.** Every package is something that can break at 6pm on the day.
Current justified set: `fastify`, `@fastify/cookie`, `@fastify/rate-limit`, `better-sqlite3`,
`sharp`, `csv-parse`.

**Do not introduce:** a bundler, a frontend framework, an ORM, a session store, Redis, a
queue, websockets, or SSE. Each was considered and rejected in the design docs.

---

## Development environment

Windows locally, exposed through a **quick** Cloudflare Tunnel (`cloudflared tunnel --url
http://localhost:3000`). The hostname changes on every restart — which is fine, because no
absolute URL is ever stored. Test devices re-enter the passphrase after a restart, since
cookies are scoped per hostname. That is the whole cost.

**The dev host is public and cannot sit behind Cloudflare Access.** Passphrase and PIN gates
on from the first session that has data, different values from the live event, no real
personal data, tunnel stopped when not testing.

**Two production behaviours cannot be verified here — do them blind:**
- Set `Cache-Control: no-store` on `/v`, `/state`, `/answer`. Cloudflare caching `/v` freezes
  the version for every device, and there are no cache rules on a quick tunnel.
- **Lowercase every uploaded filename on import.** Windows treats `Opera.webp` and
  `opera.webp` as one file; Linux does not, so media that works here 404s on the VPS.

Also: CSV carries CRLF, so trim `\r` when parsing; use `path.join` everywhere.

Load test against localhost, not the tunnel — you want the app's numbers, not Cloudflare's.

VPS at two weeks out from the event, or sooner if rehearsing with other people.

## Marking claims live in the database

`marking_claims` is a real table, not in-memory state. A process restart mid-round must not
drop every claim and let two markers onto the same question.

## Priorities

`docs/scope.md` §10 lists P0/P1/P2. Build P0 first and completely. Alias matching is listed
P1 but behaves like P0 — build it alongside the marking queue, never after.

Done means the dry run in `docs/scope.md` §11 passes, not that the features exist.

## Build order

Vertical slices that run end to end. Do not build layers.

1. Schema + seed 30 tables + `/v` and `/state` returning a hardcoded question
2. Player page: passphrase gate, name picker, captain auto-assign, answer one multiple-choice question
3. Host transitions with version guard; players follow via polling; captain takeover
4. Question import from CSV; points per question
5. Free text + round-end marking + aliases + question claim
6. Console: answered grid, table support, bonus, scores
7. Big screen
8. Images, then video unlock at reveal
9. Admin: question editor, import validation, tables and codes, settings, audit
10. Marker and Floor surfaces
11. Countback tie-break, reserve and practice questions
12. Table configuration (CSV + UI) and JSON config export/import

Each slice should be demonstrable on a phone before starting the next.

---

## Testing that actually matters

- `autocannon` against `/v` at 300 concurrent. It should be dull.
- Kill and restart the process mid-poll; clients must recover within one poll cycle.
- Two browser windows as two hosts, both pressing things, checking §2 holds.
- A phone locked for five minutes, then woken — must resync immediately, not show a stale
  question.
- Seed script for 30 tables and 240 simulated answers.

---

## Conventions

- Timestamps in UTC, formatted for display only.
- All state changes, bonuses, overrides, alias edits and answers-entered-on-behalf go to an
  audit table with role, operator and time. This is dispute evidence.
- Secrets from environment, never committed.
- `Cache-Control: no-store` on `/v`, `/state`, `/answer`. Long cache on `/media`.
- App binds to 127.0.0.1 only.

---

## Defaults

Poll at 3000 ± 500ms with jittered exponential backoff on failure. Media is served from
`/media/<sha256>.webp` — unguessable filenames, CDN-cached, never state-gated. PINs are 6
digits with a global per-role lockout as well as per-session backoff.

Timer off, leaderboard every round, images uploaded and compressed, player poll 3s, operator
poll 1s. All are settings in `docs/scope.md` §3 and `docs/technical-design.md` §16 — read
them from config, never hardcode.

No scope decisions are open. Anything new is a change: raise it rather than picking silently.
