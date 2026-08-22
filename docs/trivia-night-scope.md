# Trivia Night — Scope

*v0.4 — 22 Aug 2026. Supersedes v0.3.*
*Technical detail in `trivia-technical-design.md`. Review history in `trivia-architecture-review.md`.*

---

## 1. What we're building

A web app for a live trivia night. Each table has a unique QR code. Anyone at the table can
open it, but **one person — the captain — submits the answers**; everyone else follows along
on their own phone and can take over in one tap.

Questions are preloaded from a spreadsheet and advanced by a host. Audio and video play on
the venue's AV system, never streamed to phones; video embeds unlock on phones after the
answer is revealed.

Scoring is by table. There is no individual scoring anywhere.

The system is **multi-event**: many nights can be configured, exactly one runs at a time.

---

## 2. Confirmed decisions

### Event shape

| Item | Decision |
|---|---|
| Tables | 30, configurable — not hardcoded |
| Expected devices | 150–250 |
| Structure | 3 rounds × 10 questions = 30 total |
| Answer formats | Multiple choice and free text. No numeric type |
| Scoring | Point value per question, set in the template |
| Bonus points | Host awards ad-hoc, any amount, any time, with a reason. Additive only, never negative |
| Tie-break | Countback **excluding bonuses**: round 3, then round 2, then correct free-text answers, then a sudden-death reserve question |
| Skipped questions | Anything still `PENDING` at publish is marked `SKIPPED` and excluded from the points total |
| Practice question | Flagged, scores nothing, runs before round 1 to prove the chain |

### Play model

| Item | Decision |
|---|---|
| Answer mode | Captain only. One answer per table |
| Captain assignment | Auto-assigned to the first player to open a table's page — a table with no captain cannot answer |
| Captain handover | One tap from any non-captain screen, allowed mid-question, announced and logged |
| Non-captain view | Question, image and the table's answer. Controls absent, not disabled |
| Answer editing | Captain can change the answer until the host closes the question |
| Player identity | Username added on first use, stored per table, selectable on any device. Duplicates rejected |
| Team name | Host can pre-fill; captain can set or change it until round 1 starts; falls back to table number |
| Late tables | Score zero for missed rounds. No catch-up, no pro-rata. `joined_at_round` recorded |

### Running the night

| Item | Decision |
|---|---|
| Operators | Admin, Host, Marker, Floor |
| State transitions | Host only. Multiple host sessions are expected, not prevented — resolved by most-recent-wins plus a version guard |
| Marking | Live queue — a free-text question enters it the moment it closes and is marked during play. Must finish before the round publishes |
| Marker concurrency | A marker claims a whole question, not individual rows. Lease held in the database, renewed on any interaction |
| Reopening | Re-queues only the tables whose answer changed. Force-releases any marking claim |
| Publishing | Separate host action; snapshots the leaderboard |
| Pause | Host can pause at any point with a reason and message. Freezes players and pacing; marking, floor and admin keep working. Resumes to the exact prior state |
| Leaderboard cadence | After every round. Top five for rounds 1 and 2, full board at the end |
| Timer | Off by default. Available as a setting; server-timestamped, soft cue, never auto-submits |

### Content

| Item | Decision |
|---|---|
| Authoring | Spreadsheet template, imported with validation |
| Live editing | Future questions edit freely; `OPEN` questions blocked; marked or revealed require an impact preview and re-score |
| Images | Uploaded and compressed on import to 1200px WebP. Served from hashed filenames, CDN-cached |
| Image description | Required with any image. Must describe without naming the answer |
| Video | Optional YouTube embed per question, unlocked on phones at reveal, default muted |
| AV cues | Console displays a cue card; a human presses play |
| Licensing | Not a constraint in this environment |

### Look and feel

| Item | Decision |
|---|---|
| Team colour | Solid or gradient per team. An **identifier, not a theme** — phone header band, printed card, leaderboard swatch, floor grid. Never the content area |
| Configured theme | **Layout and colour.** Cascades per property: question overrides round overrides event default. Resolved server-side, applied to the big screen and the phone content area together |
| Layouts | Five named intents rendered natively per surface: `standard`, `image`, `media`, `statement`, `text-answer` |
| Colour tokens | `bg`, `surface`, `surface-selected`, `text`, `text-muted`, `border`, `accent`, `accent-text` — derived from background and accent when unset |
| Chrome | Logo and footer band, event level only, **outside the cascade**. Colour follows the resolved theme; the band reduces the content area rather than overlapping it |
| Contrast | Resolved themes validated at 7:1 for projection and 4.5:1 for phone token pairs. An event cannot activate with a failing resolved theme |
| Transitions | Theme applies at `PENDING`, not `OPEN`. Crossfade 400ms, instant under `prefers-reduced-motion` |

### Technical

| Item | Decision |
|---|---|
| Stack | Node, Fastify, SQLite via better-sqlite3, no frontend framework, no build step |
| Transport | Polling. `/v` returns a version integer; `/state` returns a full snapshot when it moves. No SSE, no websockets |
| Version | `max(event_version, table_version)` — a change at one table must not wake the room |
| Poll interval | 3s ± 500ms jitter while visible, plus on submit, on wake, and a manual sync button. Jittered exponential backoff on failure |
| Hosting | Small VPS, ~$5/month, hourly billed. Caddy for automatic HTTPS |
| Domain | Required, for HTTPS and a typeable fallback URL |
| Edge | Cloudflare in front for rate limiting and DDoS protection. `no-store` on `/v`, `/state`, `/answer` |
| Development | Windows local, exposed via a quick Cloudflare Tunnel. No domain or VPS until the app works. URLs always derived from the request, never stored |
| Multiple events | Many configurable, exactly one active. `event_id` on every table from the first migration |
| Cloning | Config JSON import creates a **new** event, never overwrites. Tokens and PINs always regenerated |
| Config portability | Whole event config exports and imports as JSON, separate from the database backup |
| Data retention | 30 days after the event, then delete. Exports carry team names and scores, no usernames |

### Security

| Item | Decision |
|---|---|
| Guest access | Room passphrase plus table token before anything is served |
| Token handling | `/t/:token` exchanges once for a session cookie and redirects. The token never appears in a later URL. `Referrer-Policy: no-referrer` |
| Media protection | Unguessable hashed filenames, not state gating — gating and CDN caching are mutually exclusive |
| Operator access | One 6-digit PIN per role, five total. Never a secret path alone |
| Rate limiting | Two layers: per session cookie for honest errors, global per-role lockout for attacks. **Never per IP** |
| Payloads | Built from an allowlist, never by deleting fields. No correct answer, alias or future question reaches a player before reveal |
| Output escaping | Every user value escaped on output. `textContent`, never `innerHTML`. CSP restricting scripts to self and frames to youtube-nocookie |
| Sessions | Signed stateless cookies. 12h absolute for players and operators, 2h idle for admin. Revocation is salt rotation |
| Big screen | Long random screen token in the URL. No PIN — it's opened in a dark AV booth by someone who isn't you |

### Accessibility

| Item | Decision |
|---|---|
| Re-rendering | Only on version change, never over a focused subtree. State changes announced via `aria-live` |
| Alt text | Required, authored to describe without naming the answer |
| Audio questions | Must carry a text alternative that makes them answerable without hearing |
| Never colour alone | Selected, correct and wrong states use shape, weight and words |
| Targets and text | 44px minimum targets, 16px minimum body text, pinch-zoom never disabled |
| One device per table | Team play means a phone-less player is fully included through a teammate |

---

## 3. Data model

**`event_id` is on every table.** Scoping is present from the first migration.

- `events` — id, name, date, status (draft / active / finished / archived), passphrase,
  screen_token, version, paused (JSON), theme (JSON: layout, colour, chrome), retention_until
- `teams` — id, event_id, table_number (label, not identity), seats, token, team_name,
  captain_player_id, colour (JSON), joined_at_round, table_version, archived
- `players` — id, event_id, team_id, username, created_at
- `questions` — id, event_id, round, order_no, type (mcq / text), prompt, options,
  correct_answer, aliases, points, image_ref, image_alt, video_url, av_cue, is_practice,
  is_reserve, is_skipped, theme (JSON, nullable)
- `answers` — event_id, team_id, question_id, value, submitted_by, submitted_at,
  is_correct (nullable until marked), marked_by, marked_at
- `bonuses` — event_id, team_id, round, points, reason, awarded_by, awarded_at
- `marking_claims` — event_id, question_id, marker, claimed_at, expires_at
- `event_state` — event_id, current_question_id, question_status, round_phase
- `rounds` — event_id, number, theme (JSON, nullable), phase, published_leaderboard (JSON)
- `settings` — event_id, key/value: poll interval, timer on, leaderboard cadence
- `audit` — event_id, role, operator, action, target, reason, at
- Scores derived from `answers` plus `bonuses` on read, never stored as a total.

Sessions are stateless signed cookies; there is no session table.

---

## 4. Screens

**Player** (`/t/:token` → `/play`) — passphrase gate, username picker, captain auto-assign,
question view with input for the captain and read-only for followers, takeover, locked
state, reveal with result, video embed after reveal, paused card. Team colour header band
over themed content.

**Host console** (`/ops`) — vitals strip (event, round, question, marking progress, tables
live, link, clock) above ten states: pre-flight, question open, AV cue, closed pre-reveal,
paused, bonus, marking queue, table support, scores and disputes, final. Keyboard driven.

**Marker** (`/ops`) — live queue with auto-match counts, one answer at a time, alias
acceptance, round progress, re-queue notices.

**Floor** (`/ops`) — phone-shaped. Room grid, table detail, enter answer on behalf, rename,
reassign captain, own action log. Never shows correct answers.

**Admin** (`/ops`) — ten screens: events and lifecycle, question list, question editor, live
edit warning, import and validation, media, tables and codes, theme, settings, audit and
backup.

**Big screen** (`/screen/:screen_token`) — joining instructions, live question, answer
spread, leaderboard, paused card, final. Themed, with logo and footer band.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Venue wifi or cell coverage poor | Test on site; printed answer sheets as fallback |
| Server or connection fails | State persists in SQLite, restart resumes; database downloadable between rounds |
| Marking overruns the break | Live queue worked during play; cap free text at 2–3 per round; alias lists; host can pause |
| Captain leaves with the only answering device | Takeover prominent on every non-captain screen; floor can reassign |
| A table drops off mid-round | Table support panel: reissue code, enter answers on their behalf, move to paper |
| Mark disputed | Score override with a logged reason, visible before publish |
| Two hosts act at once | Absolute commands plus version guard; stale screens snap to reality |
| Guest reaches an operator console | 6-digit PIN per role, two-layer rate limiting with global lockout |
| Answers leak to players | Payloads from an allowlist; media on unguessable filenames |
| Hostile input reaches the projector | Escape on output, CSP, length caps at the API |
| Screen reader users locked out | Re-render only on version change, never over focus |
| A theme is unreadable in the room | Resolved-theme validation at 7:1, back-of-room preview, activation blocked on failure |
| Teams share QR codes | Accepted socially; note if prizes are involved |

---

## 6. Build priorities

Cut from the bottom if time runs short.

### P0 — the night cannot happen without these

- Schema with `event_id` and split versioning
- Passphrase gate, token exchange, role PINs, output escaping
- Player: username picker, captain auto-assign, answer, takeover
- Polling with jitter, snapshot resync, staleness indicator
- Host: open, close, reveal, next, pause, with version guard
- Multiple choice auto-scoring
- Free text with a marking queue and alias matching
- Big screen: question and leaderboard
- CSV import
- Pre-flight checks and the practice question
- Score computation and round publishing

### P1 — the night is noticeably worse without these

- Floor surface and table support
- Bonus points
- Admin question editor and table configuration
- Images and alt text
- Audit log and database download
- Countback tie-break
- One theme at event level, contrast-validated

### P2 — cut without regret

- Theme cascade at round and question level, and the layout set beyond `standard`
- Logo and footer band
- Team colours
- Video unlock at reveal
- Answer spread on the big screen
- Reserve and sudden-death questions
- JSON config export/import and cloning
- Multi-event admin UI (the schema stays P0; the interface does not)
- Results export

**The P1 that behaves like a P0:** alias matching. Without it a marker judges 300 answers by
hand and the night stops. Build it with the marking queue, not after.

---

## 7. Acceptance criteria

Done means the dry run passes, not that the features exist.

**Dry run: one complete round, 10 questions, at least 6 real phones, on the venue network.**

- [ ] A phone that has never seen the site can scan, pass the gate, name a player and answer within 30 seconds
- [ ] Captain auto-assigns; a second phone takes over mid-question and the controls move
- [ ] A phone locked for 5 minutes wakes and shows the current question within one poll
- [ ] A phone in aeroplane mode for 2 minutes shows a staleness warning, then recovers
- [ ] An answer submitted after close is rejected with its own message, not a silent failure
- [ ] Two host sessions acting at once cannot skip or reopen a question unintentionally
- [ ] Free text with 3 spelling variants: aliases auto-match, the marker judges only edge cases
- [ ] "Accept for every table" re-scores correctly and is logged
- [ ] Reopening a marked question re-queues only the changed answer and releases the claim
- [ ] Pause hides the question, freezes writes, and resumes with a half-typed answer intact
- [ ] The correct answer is absent from the player payload before reveal — checked in dev tools
- [ ] A team name containing `<img src=x onerror=...>`, quotes and an emoji renders as text everywhere, including the big screen
- [ ] A bonus awarded to one table does not cause other tables to fetch a snapshot
- [ ] A token appears in the access log once per device, not once per request
- [ ] A finished event returns a plain "not running" message, not a 404 or stale state
- [ ] Every resolved theme passes 7:1 projection and 4.5:1 phone contrast
- [ ] The big screen is readable from the back of the actual room
- [ ] Round publishes; the big screen leaderboard matches the console
- [ ] The process is killed mid-round and restarts with state intact, including marking claims
- [ ] `/screen` opens from a bookmark with no typing
- [ ] A screen reader completes a full question without losing focus

**Load:** 300 concurrent pollers against `/v` for 10 minutes with no errors, keep-alive
confirmed end to end.

---

## 8. Failure runbook

One page, printed, next to the host.

| Symptom | First action | Fallback |
|---|---|---|
| Site unreachable for everyone | Check the console; restart the process | 5-minute break, paper for that round |
| Room needs to stop — speech, food, alarm | Pause with a reason | Marking continues through the pause |
| One table can't connect | Floor: show code and passphrase, then enter answers for them | Move that table to paper |
| Captain's phone dies | Any teammate taps takeover | Floor reassigns captain |
| Answers not updating on phones | Tell the room to press Sync | Read the question aloud, collect on paper |
| Marker falling behind | Pause, or reveal without scores | Publish the round late; scores catch up |
| Wrong answer in the question set | Admin edits and re-scores with impact preview | Void the question, adjust the total |
| Big screen dies | Read questions aloud; phones still have them | Continue on phones only |
| Someone reveals early | Announce it, void the question | Use a reserve question |
| Database corrupted | Restore the copy from the last round break | Paper for the remainder |

**Take a database copy at every round break.** One file, and the difference between losing a
round and losing the night.

---

## 9. Out of scope

- Individual scoring, or any mode where more than one person per table answers
- Concurrent live events — many configurable, one runs at a time
- Numeric or closest-guess questions
- Streaming AV to phones
- Accounts, passwords, persistent profiles
- Payments or ticketing
- Buzzer or speed-based scoring — polling makes response time meaningless

---

## 10. Parked — process, not technical

Question design against the open-book problem, event date and build runway, who authors the
questions, rehearsal logistics, prizes, printing and spare codes.

---

## 11. Next steps

1. Build the question template
2. Build P0 in the slices listed in `CLAUDE.md`
3. Deploy to the VPS in week one, before the app is finished
4. Rehearse on site with a dozen real phones and run the acceptance list
