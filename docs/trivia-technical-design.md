# Technical design

*v0.5 · 22 Aug 2026 · companion to `trivia-night-scope.md`*
*All findings in `trivia-architecture-review.md` are resolved in this version.*

---

## 1. Authority

Five roles: Admin, Host, Marker, Floor, Player. Full matrix in §7.7.

**Only the Host changes question and round state.** More than one person may hold the Host
PIN, and more than one Host session may be open at once — that's expected, not prevented.
Concurrent host input resolves by most-recent-wins, which is only safe because commands are
**absolute rather than relative** (§3) and carry a version guard.

Markers write `answers` marks, aliases and claims. Floor writes `answers`, `players` and
team names. Admin writes content and configuration. Neither Marker, Floor nor Admin can move
a question or a round.

---

## 2. State machine

Two levels: a question state, and a round phase. Marking lives on the round, not the
question — that's what "mark at end of round" means structurally.

### 2.1 Question states

```
   ┌─────────┐   open    ┌────────┐   close   ┌────────┐  reveal  ┌──────────┐
   │ PENDING │──────────>│  OPEN  │──────────>│ CLOSED │─────────>│ REVEALED │
   └─────────┘           └────────┘           └────────┘          └──────────┘
                              ^                    │
                              └────────────────────┘
                                    reopen
```

| State | Captain sees | Followers see | Big screen | Answers accepted |
|---|---|---|---|---|
| `PENDING` | Holding screen, or "listen up" if AV cue | Same | Round card or AV | No |
| `OPEN` | Question + input | Question, read-only, takeover offered | Question, answered count | Captain only |
| `CLOSED` | Their locked answer | Same | Question, answer spread | No |
| `REVEALED` | Correct answer; own result if scored, otherwise "scored at the end of the round" | Same | Correct answer | No |

**Multiple choice scores itself on close.** Its result is known the instant it's revealed.

**Free text does not.** It can be revealed — the room hears the answer — while the table's
own result stays pending until the round is marked. `MARKED` is no longer a gate between
`CLOSED` and `REVEALED`; it was in the per-question design and isn't now.

### 2.2 Round phases

```
   ┌─────────┐          ┌──────────┐          ┌───────────┐
   │ PLAYING │─────────>│ MARKING  │─────────>│ PUBLISHED │
   └─────────┘          └──────────┘          └───────────┘
```

- `PLAYING` — questions run. Free-text answers accumulate unmarked.
- `MARKING` — host closes the round; marker works through every free-text question in it.
  The room is on a break and the big screen says so.
- `PUBLISHED` — scores computed and the leaderboard snapshot goes to the big screen.

**Marking runs during play, not at the end.** The moment a free-text question closes, its
answers land in the marker's queue and they start work — while question 5 is still running.
The round phase describes when marking must be *finished*, not when it starts.

Done properly, the round-end break is a reconciliation of one or two stragglers rather than
a batch of ninety answers with a room waiting.

### 2.2a Pause is orthogonal, not a state

Pause does **not** belong in the question state machine or the round phases. It's a flag on
the event that overlays whatever is already happening, because the thing you need on resume
is exactly what you had before.

```
event.paused = { at, by, reason, message }
```

**What pausing does**

- Every player screen switches to a paused card with the host's message. The question is
  hidden — not greyed, hidden — so nobody reads ahead while the room is doing something else.
- Writes are rejected: answers, captain handover, name changes.
- The timer, if enabled, stops and resumes from where it was.
- The big screen shows the pause message at full size.
- **Marking continues.** This is a feature, not an oversight — "pause while marking catches
  up" is one of the two reasons you'd use it.
- Floor and admin keep working. Only players and pacing freeze.

**What resuming does**

Restores the exact prior state. A question that was `OPEN` is open again, with the same
remaining time.

**The draft must survive.** A captain halfway through typing a free-text answer when the
room pauses has to find their text still there on resume. Hold it in client state and never
clear it on a paused response — losing someone's typing to a fire drill is a small betrayal
that feels large.

**Reasons to offer as presets:** food service, a speech, marking catching up, technical
issue, fire alarm. Free text as well. Logged with reason and duration, because "why did we
run 40 minutes late" is a question someone asks afterwards.

### 2.3 The marking queue is live

The marker's screen is a queue that fills as the round runs, not a batch that appears at the
end.

- A free-text question entering `CLOSED` adds it to the queue immediately.
- The queue shows what's ready, what's in progress and who holds each claim.
- Marking a question does not require the round to be over, or the question to be revealed.
- Multiple choice never enters the queue — it scores itself on close.

**The host needs to see marking progress**, because it determines how long the break has to
be. Marking state belongs in the console's vitals strip: "round 1 · 2 of 3 marked". A host
who can see marking is nearly done can shorten the break; one who can't will either rush the
marker or stall the room.

### 2.4 Reopening a marked question invalidates marks

This is the edge case early marking creates, and it will happen: a table is missed, the host
reopens question 2, and that question has already been marked.

Rules:

- Reopening a `CLOSED` question that has marks **invalidates the marks for any table whose
  answer subsequently changes**, and re-queues only those tables.
- Marks for tables that didn't change stand. Don't make the marker redo ninety judgements
  because one table was missed.
- The console warns before reopening: "This question is marked. Reopening will re-queue any
  answer that changes."
- If the round has already published, this is a re-score and follows §9.1 — show the impact
  in tables and points before applying.

### 2.5 Consequences

- `reopen` still exists as an explicit, logged host action.
- Video embeds unlock at `REVEALED`.
- Publishing is a separate host action from revealing, and snapshots the leaderboard so it
  can't shift under the room's eyes.
- A round can be published with a question still unmarked only if the host forces it. Warn,
  don't block — someone will need to move on.

---

## 3. Commands are absolute, never relative

This is the rule that makes last-write-wins safe.

**Wrong:** `next()`, `close()`, `advance()`

Two hosts pressing "next" skips a question. A double-tap skips a question. A retried
request after a flaky connection skips a question.

**Right:** `setQuestion(id: 12, state: "OPEN")`

Two hosts pressing the same button produce the same result. Retries are harmless.
Idempotent by construction, which is exactly what "most recent input wins" needs to be safe.

### Command shape

```
POST /host/state
{
  question_id: 12,
  state: "OPEN",
  expects_version: 47      // current state version the host's screen was showing
}
```

`expects_version` is the guard. If the server has moved on, it rejects with `409` and
returns the current state, and the stale host screen snaps to reality rather than
overwriting it.

**Without the guard, this is the failure:** host A closes question 4. Host B's screen is
eleven seconds stale and still shows it open; B taps something; question 4 reopens; answers
submitted after the close now count. The version check makes that impossible.

### Two exceptions that need a confirm step

- **`REVEAL`** — irreversible in the room. Once it's on the big screen it cannot be taken
  back. Requires a confirm, and ignores a repeat within 3 seconds.
- **`PUBLISH`** — snapshots the leaderboard for the room. Re-publishing after a late mark
  change is allowed but flagged.
- **`reopen` after reveal** — the answer is already public. Allowed, but flagged.

---

## 4. Transport — polling, no streaming

No SSE, no websockets. Clients ask the server for state; the server never pushes.

This removes the failure modes that actually bite at an event: streams that die silently,
tunnel idle timeouts, heartbeats, connection state on the server, and iOS suspending a
socket the moment a phone locks. A request either succeeds or it doesn't, and the next one
comes along shortly.

### Two endpoints, one cheap

```
GET  /v      → { version: 47 }          ~20 bytes
GET  /state  → full snapshot            ~2 KB
POST /answer → { question_id, value }
```

The table is identified by the session cookie, not the URL. See §4.1 — the token never
appears in a request path after the first one.

Clients poll `/v` and only fetch `/state` when the version has moved. At 240 devices on a
3-second interval that's 80 requests/second of near-empty responses, which any small server
handles without noticing.

### 4.0 The version is split, or one table wakes the room

A single event-wide counter means a bonus awarded to table 4, a username added at table 19
or a captain handover at table 27 bumps the number every device polls — and all 240 then
fetch a 2 KB snapshot. A synchronised 500 KB burst triggered by something that concerned one
table.

```
version = max(event_version, table_version)
```

- `event_version` — question state, round phase, publish, settings. Everyone cares.
- `teams.table_version` — that table's answer, captain, players, team name. Only they care.

`/v` returns the max of the two for the caller's table. One extra column, one extra read,
and event-wide snapshots drop to roughly 30 across the night plus reconnects.

**Both increments must be atomic and inside the same transaction as the change:**

```sql
UPDATE events SET version = version + 1 WHERE id = ? RETURNING version;
```

Never read-then-write in application code.

### When clients poll

| Trigger | Why |
|---|---|
| Every 3s while visible | So a new question appears without anyone doing anything |
| On submit | Confirms the write landed and picks up any state change |
| On `visibilitychange` to visible | A locked phone missed everything; catch up instantly |
| Manual sync button | The user's escape hatch when something looks wrong |
| Never while backgrounded | No point burning battery on a locked phone |

**On the background interval.** Submission and manual sync alone are not enough. The host
opens question 5, the big screen changes, 240 people look down at question 4 and have to
tap sync before they can answer. That's an extra tap per question, thirty times, for
everyone — and the least confident people in the room will be the ones sitting on a stale
screen wondering why.

A 3-second interval makes the phone follow the room by itself. The manual button stays,
because it's a real escape hatch and it's reassuring, not because it should be the primary
mechanism.

### Jitter is not optional

Every client on a fixed 3-second interval stays in lockstep once anything synchronises them
— a server restart, a network blip, a question opening. The result is a repeating spike
instead of a flat 80 req/s, arriving at the exact moment the server is least able to absorb
it.

- Poll at `3000 ± 500ms`, re-randomised every cycle.
- On failure, exponential backoff capped at 15s, **also jittered**.
- Resume the normal interval only after a success.

---

## 5. Staleness and recovery

**Rule: never patch, always snapshot.** When the version moves, fetch the whole state and
re-render from it. Don't reconstruct from deltas.

```
GET /state/:table_token
{
  version: 47,
  round: 1,
  question: { id: 12, state: "OPEN", prompt: "...", type: "mcq",
              options: [...], points: 2, image: "/m/q12.webp" },
  our_answer: { value: "B", set_by: "Priya", at: "20:42:11" },
  team: { name: "The Quizzards", captain: "Dave", score: 14 }
}
```

A phone that missed six changes ends up in exactly the same position as one that just
scanned the code. That kills an entire class of bug.

### Showing staleness honestly

Without a push channel, the client can't distinguish "nothing has changed" from "I haven't
been able to reach the server for two minutes." So it has to track it:

- Last successful poll under 10s → normal, show nothing
- 10–30s → quiet indicator, "reconnecting"
- Over 30s → prominent warning with the sync button front and centre

The worst outcome on the night is a table confidently answering question 4 while the room
is on question 6. Visible staleness prevents that; silence causes it.

### Server-side guards

- Answers carry `question_id`. The server rejects a submission for any question not in
  `OPEN` and returns current state, so a stale phone can't submit into a closed question —
  it gets corrected instead.
- **That rejection needs its own message.** An answer submitted in the same instant as close
  is correct behaviour but looks like a bug: the captain taps, and their answer vanishes.
  Return a distinct code and render "The question closed before your answer arrived."
- Every rejection returns current state, never a bare error.
- State lives in SQLite and is the single source of truth. A crashed and restarted process
  resumes exactly where it was, and clients never notice beyond one failed poll.
- `/v` responses should be genuinely cheap: a single integer read, no joins, no work.

---

## 6. Concurrency

Four surfaces where two people can write at once. Only one of them needs real locking.

### 6.1 Answers — no conflict by construction

Only the captain can submit, so two players cannot write to the same answer. The row keyed
`(team_id, question_id)` is written and rewritten by one device.

The server still validates on every write: reject if the sender is not the current captain,
and reject if the question is not `OPEN`. Both cases return current state so a stale phone
corrects itself rather than failing silently.

**Captaincy transfer is the only race here.** Two players tapping takeover within the same
second: first write wins, the second gets a rejection naming the new captain. A submission
in flight from the outgoing captain is rejected on arrival, because the captain check
happens at write time.

### 6.2 Markers judging free text — claim the question, not the row

This is the one that needs locking, because two markers on the same question will
double-judge the same tables.

**Claim at question level, not answer level.** Marking is organised by question — one
correct answer held in your head, swept across 30 tables. So the natural unit to claim is
the question.

```
POST /mark/claim   { question_id: 5 }   → 200 or 409 with holder name
```

- A claimed question disappears from other markers' queues, showing "Sam is marking this."
- Lease expires after 2 minutes, renewed by **any interaction** — keystroke, scroll or
  mark, not only a judgement. A marker deliberating for three minutes over one awkward
  answer must not lose the claim silently, or the alias hazard in §6.3 reappears.
- Warn the holder at 20 seconds remaining with a one-tap extend.
- **The lease lives in SQLite, not memory.** A process restart must not drop every claim.
- The host can force-release from the console.
- **Reopening a question force-releases its claim** and tells the marker why their screen
  changed. Host and marker are both acting legitimately in opposite directions; the host
  wins, and the marker is never left wondering.

**Why question level and not per-row:** per-row leases mean 30 lock operations per
question, constant chatter, and a marker who stalls mid-sweep leaves scattered locked rows
that nobody can see the shape of. Question-level is one claim, visible, and matches how the
work is actually done.

### 6.3 The alias hazard — the real reason claiming matters

"Accept this spelling for every table" is not a per-row write. It mutates the question's
alias list and retroactively re-scores every other table's answer to that question.

Two markers doing that on the same question at the same time is the worst concurrency bug
available here: marks flip underneath each other, and neither marker can see why. The
question-level claim in 6.2 makes it structurally impossible, which is most of its
justification.

Alias edits are also absolute, not additive-blind: the write is the full alias set with a
version check, same guard as host commands in §3.

### 6.4 Marks are absolute

`setMark(team_id, question_id, correct: true)` — never `toggleMark()`.

A double-tap, a retry, or two operators pressing the same button all produce the same
result. Same principle as host transitions.

### 6.5 Bonus points — inserts, so no conflict, but a duplicate risk

Bonuses are appended rows, never updates, so two operators writing at once cannot corrupt
anything. Two operators awarding +1 each produces +2, which is arithmetically correct and
socially wrong — they both meant the same point.

Mitigations, none of them locking:

- The recent-awards list is already on the bonus screen. Keep it prominent.
- Soft warning on a near-duplicate: "Table 4 was awarded +1 by Sam 40 seconds ago. Award
  another?"
- Client-generated idempotency key on the request, so a double-tap or a retry can't insert
  twice.

### 6.6 Scores never conflict, because they're derived

Scores are computed from `answers` plus `bonuses` on read, never stored as a running total.
Concurrent writes therefore can't corrupt a total — there's nothing to corrupt.

**One exception worth deciding:** publishing a round snapshots the leaderboard for the big
screen. If a marker overturns a mark after publish, the board is stale until the host
re-publishes. That's the right behaviour — the board shouldn't shift under the room's eyes
— but it needs to be visible on the console: "Scores changed since publish."

### 6.7 Captain claims — first write wins

One captain per table. The first claim succeeds; later ones get a rejection naming the
current captain. The host can reassign. Team name is a captain-only write, so it has no
contention at all.

---

## 7. Auth

Three hours, one venue, no accounts. The goal is to stop casual mischief and protect the
answers, not to build an identity system.

### 7.1 The rule that matters most: never send an answer before reveal

Anyone can open developer tools on their own phone. If the correct answer is in the payload,
the quiz is over.

**Player responses must never contain:**

- `correct_answer` or `aliases` for any question not in `REVEALED`
- any future question — no preloading the next prompt, options, or image
- other tables' answers
- other tables' scores, except the published leaderboard

Enforce this by building the player snapshot from an explicit allowlist of fields, not by
taking the question row and deleting things from it. Deletion-based filtering is one
forgotten field away from leaking, and it will be forgotten when someone adds a column.

**Media is protected by unguessable filenames, not by an access check.** State-gating media
and CDN-caching it are mutually exclusive: if the CDN serves the file, Node can't enforce a
gate; if Node enforces the gate, 240 phones hit the origin for the same image at once.

So: `/media/<sha256>.webp`. Nothing to enumerate, directory listing off, long cache TTL on,
and the CDN absorbs the burst. Same trade as the screen token — an unguessable URL rather
than an access check.

### 7.1a Escape everything, everywhere

Team names, usernames and free-text answers are user input, and they render on the marker
screen, the host console and the projector. One of those is the highest-privilege browser
session in the building.

A team called `<img src=x onerror=...>` running script in the operator console is the worst
outcome in this document.

- **Never `innerHTML` for a value that came from a user.** Use `textContent`, or escape at
  the templating boundary with no exceptions.
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data:; frame-src https://www.youtube-nocookie.com; base-uri 'none';
  form-action 'self'`
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` on operator routes.
- Length-cap at the API, not just the input field: team name 32, username 20, free-text
  answer 200.
- Add a hostile-input case to the dry run: a team name with angle brackets, quotes, an emoji
  and a right-to-left override character.

**CSRF** is covered by `SameSite=Lax`, which blocks cross-site POST. Documented here so
nobody relaxes it to `None` while debugging an embed.

### 7.2 Table tokens

QR codes carry a random token, never the table number.

**The token is exchanged once, then never appears in a URL again.**

```
/t/9f3k2m4p  →  gate  →  sets session cookie  →  302 to /play
```

Every subsequent request (`/v`, `/state`, `/answer`) identifies the table from the cookie.
This matters because a token in a path leaks three ways:

- The **YouTube embed** at reveal is a cross-origin iframe; the browser sends `Referer` to
  Google carrying the token.
- **Caddy and Cloudflare access logs** record full paths, putting every table token in
  plaintext on infrastructure you don't control.
- Any external link, image or script does the same.

Exchanging once reduces that to a single log line per device instead of one per request.

Also required:

- `Referrer-Policy: no-referrer` on every response.
- Caddy configured to hash or drop the path segment for `/t/*` in access logs.
- The YouTube embed uses `youtube-nocookie.com` and `referrerpolicy="no-referrer"`.

```
/t/9f3k2m4p      not     /t/12
```

- 8+ characters from an unambiguous alphabet (no `0`/`O`, `1`/`l`).
- Random, not sequential — 30 tokens in a space that size can't be enumerated.
- Regenerated per event.
- Print the table number in large plain text beside the code so people can confirm they
  scanned their own.

A token identifies a table, nothing more. It grants: read that table's state, write that
table's answers, set usernames, claim captain. Nothing else.

Sharing a token with another table remains possible and remains accepted — but with random
tokens it has to be deliberate, not the result of someone typing `/t/13`.

### 7.3 Room passphrase

The site is on the public internet through the tunnel. A single shared passphrase gates
everything, so a stranger who finds the URL sees a prompt rather than the quiz.

```
/t/9f3k2m4p  →  passphrase prompt  →  table state
```

Token and passphrase are both required. The token says which table you are; the passphrase
says you're in the room.

**Properties**

- One passphrase for the whole event, not per table. Guests will be reading it off a screen
  in low light, so: lowercase, no punctuation, two memorable words, unambiguous letters.
- Entered once, then a cookie for the night. Nobody retypes it after their phone locks.
- Shown on the big screen during arrival and held there, plus told to the floor team.
  Printing it beside the QR on the table card is convenient but weakens the point — anyone
  photographing a table card gets both halves.
- Rotated per event.
- Applies to operator routes too, as an outer layer. Ops then adds its own PIN on top.

**Before the passphrase, nothing is served.** `/v`, `/state` and `/answer` all return 401
without a valid session. The gate page is the only thing an unauthenticated request can see,
and it reveals nothing about the event.

### 7.4 Rate limiting — do not do it per IP

This is the trap. Two hundred and forty phones on venue wifi share one NAT address. Some
carriers also put large numbers of mobile users behind a handful of IPs.

**Per-IP rate limiting on the passphrase will lock out the entire room** the moment a
dozen people fat-finger it in the same minute — and they will, because they're typing a
word off a projector in the dark.

Instead, two layers:

**Layer 1 — per session.** A cookie issued on first visit to the gate page. Exponential
backoff: short delay after 5 failures, longer after 10. This handles honest mistyping, which
is the common case.

**Layer 2 — global per role.** Per-session limiting is trivially bypassed by discarding the
cookie, so it protects nobody. A global counter per role is the one that actually constrains
an attacker:

- Count PIN failures per role across all sessions in a rolling 10-minute window.
- At 50 failures, lock that role's PIN and require an admin unlock.
- Operators are few, so a Host PIN lock should never happen by accident. Fifty wrong
  attempts in ten minutes is an attack, not a fumble.
- Surface the failure count in admin. Ten failures on the Admin PIN is worth noticing.

**The passphrase keeps only layer 1**, generously tuned. It's a doormat, and locking out a
room of guests to inconvenience one chancer is the wrong trade.

Answer writes are rate limited **per table token** — naturally scoped, no collateral damage.

A passphrase this weak isn't holding off a determined attacker anyway — it's a doormat that
stops drive-by traffic. Locking out real guests to slightly inconvenience a hypothetical
one is the wrong trade.

### 7.5 Edge protection

The tunnel already terminates HTTPS. If more blocking is wanted:

- Edge rate limiting and bot filtering can sit in front of the tunnel, which keeps junk
  traffic off the venue connection entirely.
- Identity-based access control is the wrong tool here — guests have no accounts and
  shouldn't need any.
- Geo-restricting to the event's country is cheap and removes most opportunistic scanning.

### 7.6 Operator access

```
/ops     → PIN entry → signed cookie carrying a role
```

**One PIN per role, three PINs.** Host, marker, floor. A marker who mistypes into the host
PIN field doesn't accidentally acquire the ability to reveal answers, and you can hand the
marking PIN to a volunteer without handing over the night.

- Cookie is httpOnly, expires at end of night.
- **PINs are 6 digits.** Four is 10,000 guesses; at five per second that's under an hour.
- The console lives behind the PIN, not behind an obscure path. A secret URL leaks the
  moment it's on a screen someone photographs.

**Rate limiting needs two layers** — see §7.4. Per-session limiting alone is bypassed by
discarding the cookie, so it constrains honest mistyping and nothing else.

**Re-entry has to be fast.** An operator's phone reboots mid-round. They need to be back in
with a PIN they know, not a magic link sitting in an email they can't reach on venue wifi.

### 7.6a The big screen has no keyboard

`/screen` runs on a venue laptop, often in an AV booth, sometimes started by someone who
isn't you. **Do not put a passphrase or a PIN in front of it** — it will be typed wrong in
the dark, or not at all.

Instead: a long random screen token in the URL, generated in admin and opened once at
setup. `/screen/7hq2m9x4`.

It is a display surface only. It cannot write, and it is subject to the same allowlist as
players — it never holds a correct answer before that question is revealed. Someone reading
it over a shoulder learns nothing they can't see from their seat.

### 7.6b Tokens and session lifetimes

Two different things are often confused here. **Tokens** are long-lived identifiers printed
on paper or saved in a bookmark. **Sessions** are signed cookies issued after someone proves
they belong.

#### Tokens

| Token | Where it lives | Length | Grants | Lifetime |
|---|---|---|---|---|
| Table token | QR code on the table, `/t/:token` | 8 chars, unambiguous alphabet | Identifies a table. Nothing on its own | Life of the event |
| Screen token | Bookmark on the venue laptop, `/screen/:token` | 12 chars | Read-only display | Life of the event |
| Room passphrase | Announced and on the big screen | Two lowercase words | Proves presence in the room | Life of the event |
| Role PIN | Told to operators | 4–6 digits | Role, after rate-limited entry | Life of the event |

All four are **per event** and all four are **regenerated on clone**. A token from last
month resolves to a finished event and is rejected.

**A table token alone does nothing.** It must be combined with the passphrase to get a
session. That's the point of having both: the token says which table, the passphrase says
you're in the room.

#### Sessions

Signed cookies, stateless, no session table. `httpOnly`, `Secure`, `SameSite=Lax` — Lax
rather than Strict because scanning a QR is a top-level navigation from the camera app.

| Session | Carries | Expiry |
|---|---|---|
| Gate | Nothing but an id | 12h. Issued on first visit purely so rate limiting has something to key on |
| Player | `event_id`, `team_id`, `player_id` | 12h absolute |
| Host / Marker / Floor | `event_id`, `role` | 12h absolute |
| Admin | `event_id`, `role` | 2h idle |

**Absolute, not sliding, for everyone except admin.** A sliding window would log out a phone
that sat in a pocket through round 2, which is exactly the wrong moment. Twelve hours covers
setup through to the end of the night with room to spare.

**Admin is the exception** because it's the only role that can rewrite scored questions and
delete data. It's used before doors and rarely during, so a 2-hour idle timeout costs
nothing and closes the "laptop left open in a venue" hole.

#### What is deliberately *not* in the cookie

**Captaincy.** It lives in `teams.captain_player_id` on the server. If it were in the
cookie, handover couldn't work — the outgoing captain's phone would keep believing it holds
the role until the cookie was reissued.

The same reasoning applies to anything that another actor can change: score, team name,
question state. The cookie carries identity, never authority.

#### Revocation

Stateless cookies can't be revoked one at a time. If a session must be killed — a PIN spoken
too loudly, a device lost — rotate that event's signing salt. **That invalidates every
session for that event**, so everyone re-enters the passphrase or their PIN.

That's a blunt instrument, and it's the right trade for a three-hour event: a session store
would add a moving part to avoid a scenario that ends with "tell the room the passphrase
again."

#### The residual risk

Someone with the table token and the passphrase can claim captaincy and sabotage a table's
answers. This is accepted rather than solved: takeover is announced to the table, logged
with a name, and floor can reassign in one tap. A social problem with a social fix.

### 7.7 What each role can do

| | Admin | Host | Marker | Floor | Player |
|---|---|---|---|---|---|
| Pass the room gate | Yes | Yes | Yes | Yes | Yes |
| Edit questions, aliases, media | Yes | No | Aliases only | No | No |
| Import / replace question set | Yes | No | No | No | No |
| Re-score a revealed question | Yes | No | No | No | No |
| Manage tables, codes, settings | Yes | No | No | No | No |
| Download database / audit log | Yes | No | No | No | No |
| Change question state | No | Yes | No | No | No |
| Reveal answers | No | Yes | No | No | No |
| See correct answers | Yes | Yes | Yes | No | Only after reveal |
| Mark free text | Yes | Yes | Yes | No | No |
| Edit aliases | Yes | Yes | Yes | No | No |
| Award bonus | No | Yes | No | No | No |
| Override a score | Yes | Yes | No | No | No |
| Enter an answer for a table | No | Yes | No | Yes | Own table only |
| See table connection status | Yes | Yes | No | Yes | No |
| Rename a team or player | Yes | Yes | No | Yes | Captain: team name |

Floor deliberately cannot see correct answers. They're walking the room among players,
holding a phone at chest height, and the screen is readable over a shoulder.

### 7.8 Transport and logging

- HTTPS only, terminated by the tunnel. No plain HTTP path to anything.
- Every state transition, bonus, override, alias edit and answer-entered-on-behalf is logged
  with role, operator and timestamp. This is dispute evidence, not security.

---

## 8. Stack

Optimised for one thing: not falling over for three hours, in a room, with no chance to
debug. Boring beats clever.

### 8.1 Recommendation

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node LTS | Ubiquitous, well understood, easy to deploy under systemd |
| HTTP | Fastify | Fast, small, good plugin story for cookies and rate limiting |
| Database | SQLite via `better-sqlite3` | Synchronous driver, microsecond reads, no pool to misconfigure |
| Frontend | No framework, no build step | See 8.3 |
| Reverse proxy | Caddy | Automatic HTTPS and renewal, three-line config |
| Process | systemd | Restarts on crash, starts on boot |
| Images | `sharp` | Resize and WebP on import |
| Import | `csv-parse`, plus SheetJS if xlsx is wanted | Template ingest |

### 8.2 Why SQLite, and how to configure it

The `/v` endpoint is a single integer read. With a synchronous driver that's measured in
microseconds, so 80 requests/second costs the event loop essentially nothing. An async
driver and a connection pool would add moving parts and solve a problem this workload does
not have.

Non-negotiable settings:

```sql
PRAGMA journal_mode = WAL;      -- readers don't block the writer
PRAGMA synchronous = NORMAL;    -- safe with WAL, much faster than FULL
PRAGMA busy_timeout = 5000;     -- wait rather than throw under contention
PRAGMA foreign_keys = ON;
```

WAL is the important one. Without it, a single write blocks every reader, and at 80 polls a
second that's visible.

The whole database is one file. Copy it to a USB stick between rounds and you have a
complete backup of the night.

### 8.3 Frontend — no framework

The "never patch, always snapshot" decision in §5 makes a framework mostly redundant. Every
poll returns whole state; each surface has a single `render(state)` function that redraws
from it. That's the useful half of React, in about forty lines, with no build step and no
hydration.

What this buys:

- **Payload.** 240 phones on venue wifi, some on 3G in a basement function room. A 5 KB page
  loads when a 200 KB bundle doesn't.
- **Nothing to break.** No build, no bundler version, no transpile step at 6pm on the day.
- **Debuggable in the room.** View source is the source.

**Where to defer:** if whoever builds this is markedly faster in React or Svelte, use it.
About 40 KB gzipped is a real but survivable cost, and a finished app beats an elegant
unfinished one. The architecture doesn't care either way.

Three separate pages, not one app: `/t/:token` (player), `/ops` (console), `/screen` (big
screen). They share a stylesheet and a poll helper, nothing else.

### 8.4 Sessions and rate limiting

- Signed cookies via `@fastify/cookie`. No session store — the cookie carries the table
  token or the operator role, signed with a server secret. Stateless, survives a restart.
- `@fastify/rate-limit` keyed on the **session cookie**, never the IP. See §7.4 — per-IP
  limiting locks out the whole venue.

### 8.5 Deployment shape

```
Cloudflare  →  Caddy (443, auto-TLS)  →  Node app (127.0.0.1:3000)  →  quiz.db
                                                                    →  /media
```

- App binds to localhost only. Caddy is the only thing on a public port.
- `Cache-Control: no-store` on `/v`, `/state`, `/answer`; long cache on `/media`.
- systemd unit with `Restart=always`.
- Media on disk beside the database, not in it.

### 8.6 Before the night

- Load test with `autocannon` against `/v` at 300 concurrent. It should be dull.
- Restart the process mid-test and confirm clients recover within one poll.
- Rehearse with real phones on the venue's actual network, not a desk.

---

## 9. Admin surface

Separate from the host console, behind its own PIN. Admin prepares the night; host runs it.
The separation exists because admin can rewrite scored questions and the host deliberately
cannot.

### 9.1 Edit safety by question state

| Question state | Editing behaviour |
|---|---|
| Not yet reached | Edit freely, no warning |
| Currently `OPEN` | **Blocked.** Every phone would re-render mid-answer. Host must close first |
| `CLOSED` | Allowed with confirmation; re-queues affected tables for marking |
| `REVEALED` | Allowed with an impact preview and a logged reason |

**Impact preview is required before any re-score.** Show it counted in tables and points —
"7 tables go from wrong to correct, +14 points" — and flag that a published leaderboard
needs re-publishing. Never re-score silently.

### 9.2 Table configuration

Tables are configured, not hardcoded to 1–30.

**CSV upload:** `table_number, seats`. Table number is a label and may be `12`, `T4` or
`12A` — it is never the identity.

```
table_number,seats
1,8
2,8
12A,6
```

**Add, remove and edit in the UI** as well as by CSV, because a table appears on the night
and someone needs to add it in ten seconds without opening a spreadsheet.

**Renumbering is safe.** The token is the identity and the number is only a display label,
so changing `12` to `12A` doesn't invalidate a printed code. Say so in the UI — people will
assume otherwise and avoid a change they should make.

**Removing a table is not safe** once it holds answers. Block removal after the event starts
and offer archive instead, which hides it from the room view and excludes it from the
leaderboard while keeping its data.

**Seats earn their place in two screens:** pre-flight shows joined against expected ("table
12: 3 of 6 seats"), which is a much better signal than a bare scanned count; and floor sees
a table that's fuller or emptier than configured, which is usually where a problem is.

Seats are guidance, never enforcement. Never block a seventh person at a six-seat table.

### 9.3 Configuration backup as JSON

Distinct from the database backup, and both are needed.

| | Config JSON | Database file |
|---|---|---|
| Contains | Questions, aliases, tables, settings, media manifest | Everything, including answers, marks, bonuses, audit |
| Portable | Yes — move between machines | Same schema only |
| Use | Move dev to production, reuse next event, version the question set | Disaster recovery mid-event |

**Export** produces one JSON file with a `schema_version`. Media files are referenced by name
in a manifest, not embedded — a separate folder alongside keeps the JSON readable and
diffable.

**Import** validates against the schema version, previews the same way a CSV import does,
and is blocked once the event has started. Importing config never touches answers.

This is the mechanism for building on a laptop and deploying the real content to the VPS:
export locally, import remotely, upload the media folder.

### 9.3a Templates

Shipped alongside the app, not written from scratch by whoever authors the questions:

- `trivia-import-template.xlsx` — authoring workbook with dropdowns for type, layout, round
  and the y-flags, a worked example row, and reference tabs for alt text and layouts. Saved
  as CSV to import.
- `questions-template.csv` and `tables-template.csv` — exactly what the importer reads.
- `config-example.json` — the shape of an event export, annotated with what is never exported
  and what regenerates on import.

Two conventions the templates fix in place: **pipe-separated lists** for options and aliases
(commas collide with CSV), and **filenames only** for images, uploaded separately in Media.

### 9.4 Import validation

Validate and preview before committing; never half-import. Errors block a row, warnings
don't:

- **Error:** choice type with no options; missing correct answer; unparseable points
- **Warning:** points far outside the range used elsewhere; duplicate order numbers;
  referenced image not present in the upload

Replace-all is blocked once the event has started.

### 9.5 Undecided scope items become settings

Poll interval, timer on/off, leaderboard cadence, tie-break method and whether the captain
can lock answers are all configuration rather than hardcoded. That defers the open decisions
in scope §3 cheaply and lets them be changed at rehearsal.

### 9.6 Media pipeline

Compress on upload — resize to 1200px, convert to WebP. Store beside the database on disk.
Show original and processed size so an unprocessed file is obvious. Serving is still gated
by question state per §7.1.

---

## 10. Accessibility

Two of these are architectural and conflict with earlier decisions. The rest is discipline.

### 10.1 Re-rendering breaks screen readers — this is the big one

§5 says never patch, always snapshot: every poll re-renders from whole state. Done naively,
that replaces the DOM every three seconds, which for a screen reader user means focus is
destroyed mid-sentence, announcements restart, and typing into a free-text field is
impossible.

**Rules:**

- Only re-render when `version` actually changes. An unchanged poll must touch nothing.
- Never replace a container holding focus. If the user is in the answer field, update
  everything around it and leave that subtree alone.
- Announce state changes through a small `aria-live="polite"` region — "Question 5 open",
  "Answers closed", "Your table answered Sydney" — rather than expecting the user to
  discover a silently swapped screen.
- Preserve scroll position and focus across renders. Keying elements stably is enough.

The architecture survives this; it just can't be implemented as `innerHTML = render(state)`
on the player page.

### 10.2 Alt text that doesn't give away the answer

An image question needs alt text or blind and low-vision players simply can't play. But
`alt="Sydney Opera House"` hands over the answer.

So alt text is authored per question, describing without naming:

> A white building with overlapping curved shell roofs, on a harbour at dusk.

This is a required field on any question with an image, with that guidance shown inline in
the admin editor. It cannot be auto-generated — the whole point is deliberate omission.

Same principle for the reveal: once revealed, the alt text can name the thing.

### 10.3 Audio questions exclude people, by default

An audio round is inaccessible to deaf and hard-of-hearing players, and hard for everyone
in a noisy venue with bad acoustics.

- Every audio question carries a text alternative shown on phones — a description, lyric
  fragment, or context line that makes the question answerable without hearing it.
- Consider whether an audio round is the right call at all if anyone attending is deaf.
  That's a content decision, not a code one, but the system should make the alternative
  easy rather than optional.

### 10.4 The room is a hostile environment for everyone

Dim lighting, noise, drinks, small screens, and people who've had a few. Design for
temporary impairment as the default case, not the exception:

- Tap targets at least 44×44px. No drag, no long-press, no double-tap.
- Body text 16px minimum on phones — also stops iOS zooming on input focus.
- Contrast at WCAG AA, 4.5:1 for text.
- **Never colour alone.** Selected answer uses border weight and fill; correct and wrong use
  an icon and a word, not green and red. Roughly 1 in 12 men has a colour vision deficiency,
  and this is a pub.
- Don't disable pinch-zoom in the viewport tag.
- No flashing or rapid animation on reveal.

### 10.5 Big screen

- Sized to be read from the back of the room, tested from the back of the room.
- Question text never below 32px at projector resolution.
- Don't rely on the projector alone: every question also appears on phones, which is why
  images go to phones as well.

### 10.6 Cognitive and situational

- One action per screen. The player page asks exactly one thing at a time.
- Locked and open states must be unmistakably different, in shape as well as colour.
- Plain language throughout. "Answers closed", not "Question state: CLOSED".
- Host-controlled pacing rather than a countdown removes time pressure for anyone who
  reads or types slowly. If a timer is enabled, it's a soft cue and never auto-submits.

### 10.7 Where team play helps

One phone per table is enough. Someone with no smartphone, a flat battery, or no data plays
fully through a teammate's device — the team is the unit, not the person. Worth stating
explicitly in the joining instructions rather than leaving people to work it out.

Passphrase entry deserves care: no autocapitalise, no autocorrect, and the floor team should
be able to tell anyone the passphrase rather than expecting them to read a projector.

---

## 11. Captain model

One answer per table, submitted by one person. Everyone else follows along on their own
device and can take over at any time.

Open mode — any player answering, first-wins with overwrite — was designed and then cut. See
scope §3.1.

### 11.1 Captaincy must auto-assign

**The hazard:** a table that never nominates a captain cannot answer at all. Table 19 sits
through question 1 doing nothing and nobody notices until the scores look wrong.

The first player to open a table's page becomes its captain automatically, with a visible
note and one-tap handover for anyone else. Never present an empty captain slot as a
prerequisite to playing.

### 11.2 Handover

- One tap, from any non-captain device, with a confirmation naming the current captain.
- Allowed mid-question. A dead battery doesn't wait for a convenient moment.
- Broadcast to the table: "Marcus is now captain."
- Logged; also reassignable from the host console and admin.
- Unauthenticated, like usernames. Someone can seize captaincy from a working captain — a
  social problem, mitigated by visibility rather than by permission.

**Make takeover prominent, not buried.** The one real weakness of this model is a captain
who wanders off with the table's only answering device. Takeover on every non-captain
screen is the mitigation, so it belongs in the main flow rather than behind a menu.

### 11.3 Non-captain view

Other players still see the question, the image, and what their table has answered. Answer
controls are **absent rather than disabled**, with the reason stated.

Keep the confirmation line — "Dave answered Sydney at 8:42" — even though there's no
conflict to resolve. It lets the table see their answer landed without leaning over the
captain's shoulder.

This also does accessibility work: someone at the back who can't read the projector follows
on their own phone whether or not they're answering.

---

## 12. Tie-break, and dropping the numeric type

**The numeric question type is removed.** It existed only to serve a closest-guess
tie-break, and it's the most expensive type to build: a distinct input, and scoring that
compares all 30 answers against each other rather than judging each independently. Every
other type judges a table in isolation.

`questions.type` is now `mcq | text`.

### 12.1 Tie-break by countback

Resolved in scoring, with no new UI and no new question type:

1. Higher score in round 3, **excluding bonuses**
2. Then round 2, excluding bonuses
3. Then number of free-text questions answered correctly across the night
4. Still tied → host runs a sudden-death question from a small reserve set

**Bonuses are excluded from countback deliberately.** They're host discretion awarded for a
good heckle, not evidence of quiz ability, and letting one decide a prize invites exactly
the argument you don't want. They still count in the headline total.

This requires `bonuses.round` so a bonus can be attributed and reported, even though
countback ignores it.

Countback is deterministic, computes from data already held, and resolves silently before
anyone notices there was a tie. Steps 1–3 cost a scoring function; step 4 costs a flag on a
few spare questions.

**Not fastest submission.** Polling makes response time meaningless — a table on a 3-second
cycle can't be compared to one that just refreshed.

### 12.2 Reserve questions

Questions flagged `is_reserve` sit outside the numbered rounds, don't appear in the running
order, and are never counted in the points total. The host can open one at any time. This
covers sudden death, and doubles as a spare if a question turns out to be broken.

---

## 12.3 Skipped questions

A host can jump from question 4 to question 6. Question 5 then sits `PENDING` forever, and
the advertised points total is wrong for the rest of the night.

**Rule:** when a round publishes, any question still `PENDING` is marked `SKIPPED`, excluded
from the points total, and listed on the console. Recompute the round's available points
from questions actually asked, never from the imported set.

Without this, "41 points available" is a lie the moment anything is skipped, and every
score looks wrong to a table doing the arithmetic.

---

## 13. Marker and Floor surfaces

Both sit at `/ops` behind their own PIN, scoped to their role. Neither can change question
state.

### 13.1 Marker

A live queue that fills as questions close, worked during play. Shows auto-matched counts up
front so the size of the job is visible before opening it. One answer at a time, large, with
`Y` / `N` / `A` keys. "Accept this spelling for every table" rewrites the alias list, which
is why a marker claims the whole question (§6.3).

Round progress stays visible, including whether marking is blocking publication.

A reopened question returns to the queue **with the reason shown**, carrying only the tables
whose answers changed.

### 13.2 Floor

Phone-shaped, for someone standing and walking. The room as a tappable grid, then a short
list of tables that actually need a visit.

Per table: show their code and the passphrase, enter an answer on their behalf, reassign
captain, or move them to paper. Renaming a team lives here too, because the person who spots
a name that shouldn't be projected is the one walking the room.

**Floor never sees correct answers.** That screen is readable over a shoulder in a crowded
room, and entering an answer means typing what a table dictated, not helping them.

Every floor action is logged with a reason and appears in the admin audit log.

---

## 14. Practice question

A question flagged `is_practice`:

- Runs before round 1, using the normal question flow end to end
- Scores nothing and never appears in totals or the leaderboard
- Exists to prove the chain — tunnel, phones, captain assignment, answers arriving — while
  it's still cheap to fix

The pre-flight "test question to all tables" opens it. If tables can't answer it, you have
time to walk the room before the night starts.

---

## 15. Data retention

The database holds usernames and team names. Lightweight, but real.

- Keep for 30 days after the event to settle any disputes, then delete.
- The exported results CSV keeps team names and scores only, no usernames.
- State this on the joining screen in one line.

---

## 16. Multiple events

`event_id` is on every table from the first migration, even while only one event exists.
Retrofitting it later means touching every query, every payload and every index.

### 16.1 One active event at a time

Many events can be configured; exactly one is **active** on a running server.

Concurrent live events were considered and rejected. The failure mode is a host opening a
question on the wrong event in front of a room, and there is no graceful recovery from
that. Sequential events cost nothing — the constraint buys real safety.

The active event's name sits in the host console vitals strip permanently, next to the
round and question. If it says the wrong thing, that's the first thing anyone notices.

### 16.2 Routing needs no event in the URL

Tokens are random and globally unique, so they resolve to an event by themselves:

- `/t/:token` → table, and therefore event. Player URLs are unchanged.
- `/screen/:screen_token` → same.
- `/ops` → PIN entry. **PINs are per event**, so the PIN selects the event as well as the
  role. Admin picks from a list; the other roles land directly in the active event.

The room passphrase is per event too. All of these rotate per event anyway, so scoping them
costs nothing and prevents a stale PIN from a previous night opening tonight's console.

### 16.3 What is scoped, and what isn't

| Per event | Global |
|---|---|
| Questions, aliases, media manifest | Server secret |
| Tables, tokens, seats, teams, players | Poll interval defaults |
| Answers, marks, bonuses, rounds | Media storage root |
| Settings, passphrase, PINs, screen token | Audit log (with `event_id` on each row) |
| Retention date | |

### 16.4 Cloning is the point

Config JSON import **creates a new event, never overwrites one.** That makes it the clone
mechanism: take last month's question set, import it as a new event, generate fresh tokens,
edit the questions that got a laugh and drop the ones that didn't.

- Cloning copies questions, aliases, settings and table configuration.
- It never copies answers, marks, bonuses, players, teams or tokens. Those are the night,
  not the setup.
- Tokens and PINs are regenerated on clone, always. Reusing a printed code from a previous
  event is a security hole and a support call.

### 16.4a A token whose event isn't running

A table token resolves to exactly one event, which may be `draft`, `finished`, `archived`,
or simply not the active one. Phones will keep polling after the night ends, and a
deactivated event mid-night is possible.

Return a terminal `event_not_running` state that the client renders as a plain message with
the event name and date. **Never a 404** — that looks broken. **Never stale state** — that
looks live. Stop polling once it's received.

### 16.5 Lifecycle

`draft → active → finished → archived`

- Only one event may be `active`. Activating one deactivates the current active event, with
  a confirmation that names it.
- Activating is blocked if the current active event is mid-round.
- `finished` events are read-only: results viewable, exports available, no state changes.
- `archived` hides an event from the default list. Retention counts from the finish date.

---

## 17. Development environment

Built and tested on Windows, exposed through a **Cloudflare Tunnel**. Production is Linux on
a VPS behind the same Cloudflare edge.

### 17.1 Why a tunnel rather than a private network

- **Any phone can reach it.** No enrolment, no client software, no account — so rehearsal
  with real attendees' phones is possible on the dev build.
- **No inbound firewall rules.** `cloudflared` makes an outbound connection, so the Windows
  firewall problem doesn't arise.
- **Real HTTPS.** TLS terminates at the edge, so `Secure` cookies work against a valid
  certificate.

### 17.1a No absolute URLs, anywhere

The database stores **tokens, never links**. The QR sheet, the big screen's join instructions
and any share link render from the incoming request's host at generation time.

This is what lets development run on a quick tunnel whose hostname changes every restart, and
it makes the eventual move to a real domain a configuration change rather than a migration.

The only residual cost of a changing hostname is session cookies, which are scoped per host —
test devices re-enter the passphrase after a restart. Nothing else breaks.

### 17.2 Quick tunnel during the build

```
cloudflared tunnel --url http://localhost:3000
```

A fresh `*.trycloudflare.com` hostname every restart, no domain and no DNS wait. Given 17.1a,
the churn costs one passphrase re-entry per test device.

A `dev.ps1` that starts the app and the tunnel, greps the hostname from cloudflared's log and
prints it as a terminal QR makes a restart a three-second operation.

**A named tunnel on a real subdomain becomes worth it later** — when QR codes need printing,
when several people are testing at once, or when the VPS arrives. Not before.

### 17.3 The dev host is public and cannot be gated

This is the real trade. A `trycloudflare.com` hostname is on the public internet, and
**Cloudflare Access cannot be put in front of it** — you don't control that zone.

- Passphrase and PIN gates in the app **from the first session that stores anything**, not
  "later".
- Different passphrase and PIN values from the live event, so a leak from dev doesn't open
  the night.
- No real personal data in dev, ever.
- Stop the tunnel when not testing. An app on localhost is unreachable; a tunnel is not.

The hostname is long and random, so drive-by discovery is unlikely. That is not protection
and must never be treated as any.

### 17.4 Two production behaviours cannot be verified here

A quick tunnel gives no zone control, so there are no cache rules, no WAF and no rate limiting
to exercise. Both of the following must be built blind and verified on the first VPS deploy:

- **`Cache-Control: no-store` on `/v`, `/state`, `/answer`.** Cloudflare caching `/v` freezes
  the version number for every device — the failure that stops the whole room updating.
- **Lowercase every uploaded filename on import.** Windows treats `Opera.webp` and
  `opera.webp` as one file; Linux does not, so media that works here 404s on the VPS.

Load testing should run against **localhost**, not the tunnel — you want the application's
numbers, not Cloudflare's.

### 17.5 Windows traps that remain

The tunnel removes the firewall problem. These stay, because they're about the operating
system rather than the network:

**Case sensitivity is the one that reaches production.** Windows treats `Opera.webp` and
`opera.webp` as the same file. Linux does not. Media that works on the dev box 404s on the
VPS. Normalise every uploaded filename to lowercase on import.

**Line endings.** CSV saved on Windows carries CRLF. Trim `\r` when parsing, or the last
column of every row gains an invisible character and alias matching quietly fails.

**Paths.** `path.join` throughout, never string concatenation with a forward slash.

**better-sqlite3** is a native module. It normally installs from a prebuilt binary; if it
compiles, it needs Visual Studio Build Tools. Sort that on day one.

### 17.6 When to move to the VPS

Local-first is the plan: build the whole app before provisioning a server. Move when any of
these is true:

- P0 works end to end on your phone
- You want to rehearse with people who aren't you
- You are **two weeks** from the event

That last one is a hard line. The VPS step contains DNS propagation, certificate issuance and
possible identity verification — all fine with slack, all fatal on the day.

---

## 18. Hardening details

### 18.1 Upload and import limits

Admin accepts images, CSV and JSON. All three need caps, checked server-side:

- Image: 5 MB, real MIME sniffed after decode rather than trusted from the extension,
  dimensions capped before `sharp` touches it, output rejected above ~150 KB.
- CSV: 500 rows, 1 MB.
- JSON config: 5 MB, validated against `schema_version` before anything is written.
- Reject anything that fails to decode as the type it claims.

### 18.2 A 401 must look like a passphrase prompt

Rotating an event's signing salt invalidates every session at once (§7.6b). If the client
renders the resulting 401 as an error, the room sees an outage instead of a prompt.

**Any 401 on a player route redirects to the gate.** Rotation should feel like "enter the
passphrase again", because that is all it is.

### 18.3 Disk exhaustion

SQLite write failures under a full disk surface as generic errors mid-round.

- Pre-flight checks free space and refuses to start below 1 GB.
- Media upload checks available space before writing.
- The vitals strip shows free space if it drops below 2 GB.

### 18.4 Uniqueness rules the editor must enforce

Import validates these; the admin editor originally did not.

- **Duplicate `order_no` within an event** — rejected on save, not only on import.
- **Duplicate username within a table** — rejected at the API with a suggestion ("Dave 2").
  Two people called Dave make the picker ambiguous and attribution meaningless.

### 18.5 Late-arriving tables

A table that joins in round 2 scores zero for round 1 and sits at the bottom. That is
accepted rather than corrected — no catch-up, no pro-rata.

Record `joined_at_round` so the console can explain it when someone asks, and so it's
visible in the export.

### 18.6 Keep-alive

At 80 req/s, TLS handshakes dominate if connections aren't reused. Verify keep-alive end to
end — Cloudflare to Caddy to Node — and assert it during the `autocannon` run.

---

## 19. Team colour

Each team has a colour — solid or gradient — set by admin. Not a theme, and deliberately not
called one: it's a single visual attribute used as an identifier, nothing more.

It appears on the printed QR card, as the header band on that table's phones, as a swatch on
their leaderboard row, and in the floor console's table grid.

The point is wayfinding: "you're the amber table" is easier to shout across a room than
"table 17", and floor spotting a colour is faster than reading numbers.

### 19.1 Shape

```json
{ "type": "block",    "from": "#C2410C" }
{ "type": "gradient", "from": "#C2410C", "to": "#7C2D12", "angle": 135 }
```

### 19.2 Rules that keep it safe

- **Colour is never the sole identifier.** The table number appears with it, always,
  everywhere. Two tables could be handed similar colours and nothing should break.
- **It occupies the header band and small markers only** — never the content area. The
  content belongs to the configured theme (§20).
- **Validate contrast at assignment.** Admin computes the contrast of its own foreground
  against the theme and rejects a combination below 4.5:1. A table shouldn't be able to
  configure itself into unreadability.
- **Mid tones print and project better** than very dark or very saturated ones, which go
  muddy on a phone at low brightness in a dim room.
- Gradients render as a band; keep both stops within the same contrast band so text over
  either end stays legible.

### 19.3 Assignment

- A curated palette of 16 distinguishable hues, checked against common colour vision
  deficiencies rather than just picked to look nice.
- **Auto-assign** spreads the palette across tables and repeats only when it must — with 30
  tables and 16 hues, repeats are guaranteed, so pair a repeated hue with a different
  block/gradient treatment.
- Manual override per table, plus bulk apply from the table CSV via an optional `theme`
  column.
- Unset means a neutral default. Never a random colour.

---

## 20. The configured theme

One theme system, applied to **both the big screen and the phones**. Set at three levels —
event, round, question — with question winning, then round, then the event default.

A theme carries **layout and colour**.

### 20.1 What's configurable

**Layout** — a named presentation variant, not a geometry. See 20.1a.

**Colour** — background (solid or gradient), accent, and the token set in 20.9.

**Chrome** — set once at event level and **deliberately outside the cascade**: title and
subtitle for holding screens, logo, optional footer band. Big screen only; phones have no
room for it.

Chrome doesn't cascade because it's the night's branding, not the moment's. A sponsor strip
that vanishes for round 2 is a bug, not a feature.

### 20.1a Layout is an intent, rendered natively per surface

A projector is 16:9 and read from 30 metres. A phone is portrait and held at arm's length.
No single arrangement works on both, so layout is a **named intent** that each surface
renders in its own way.

| Layout | Big screen | Phone |
|---|---|---|
| `standard` | Prompt large, options in a 2×2 grid | Prompt, then stacked options |
| `image` | Image dominant, prompt reduced beneath | Image at full width, prompt below, options stacked |
| `media` | Minimal — title only, no prompt while the clip plays | "Listen up" holding card |
| `statement` | Prompt only, at maximum size, no options shown | Prompt large, options below the fold |
| `text-answer` | Prompt large, no options | Prompt, then the input field |

Adding a layout means adding a renderer on each surface. Keep the set small — five is
plenty, and every addition is two implementations plus a preview.

Layout cascades per property like everything else, so a picture round sets `image` once and
its ten questions inherit it.

### 20.1b Logo and footer band

Position and content are fixed once. **Colour follows the resolved theme**, so both adapt as
the cascade changes while staying where they are.

- **Logo** — top corner, inside the 5% safe margin, height capped at about 5% of screen
  width. Sits on a themed chip rather than directly on the background.
- **Footer band** — full-width strip at the bottom, fixed height, using the `surface` and
  `border` tokens. Sponsor text or a hashtag.

**The band reduces the content area; it never overlaps it.** Every layout has to lay out
inside the remaining space, or the statement layout's oversized prompt runs under the
sponsor's name at the worst possible moment.

**A single logo file won't survive both a light and a dark theme.** Upload two variants and
pick by the resolved background's luminance. Otherwise a festive light round makes a
white-on-transparent logo disappear entirely. If only one is supplied, the themed chip
behind it keeps it visible — but two is better.

Footer text contrast is validated against the band, not the page background, at the same 7:1
projector bar.

### 20.2 Projector constraints, which are not the same as phone constraints

**A projector cannot render black.** It renders black as whatever the ambient light in the
room is. A pure-black background arrives as dark grey, and any true-black element sitting on
it looks like a rectangle of dirt. Design with a single dark tone rather than mixing near-
black and black.

**Pure white glares.** On a bright projector in a dim room, `#FFFFFF` blooms and text edges
smear. Use a near-white around `#F5F5F0`.

**Contrast has to clear a higher bar than a phone.** Ambient light, a dusty lens and a
cheap screen all subtract. Require **7:1** for projected body text rather than the 4.5:1
used elsewhere, and reject mid-tone-on-mid-tone combinations outright at assignment.

**No text over a background image.** Ever. It survives the preview on a laptop and fails in
the room. If a background image is wanted, it belongs on the holding screen with no text
over it.

**Respect the safe margin.** Projectors crop and keystone. Keep all content inside a 5%
margin, and never put anything essential in a corner.

### 20.3 Preview must simulate the room, not the laptop

Admin previews at 16:9 with two modes:

- **Full size** — what the projector renders.
- **Back of the room** — the same frame scaled to roughly a tenth, which is what a person
  30 metres away actually resolves. If the leaderboard is unreadable at that size, it's
  unreadable on the night.

The second preview is the one that catches problems. A theme that looks refined on a laptop
is often unreadable from row twelve.

### 20.4 Where team colour meets the configured theme

A team's colour appears on the big screen only as a **swatch or row marker beside its
leaderboard entry — never as text colour and never as a row background.**

Otherwise every team's contrast against the theme background becomes a separate problem, 30
times over, and one of them will fail. A fixed-size swatch works against any background.

On phones it's the header band and nothing else, with a hairline border so it stays distinct
against any theme below it.

### 20.5 The cascade

Three levels. Question wins, then round, then the event default.

```
question.theme  →  round.theme  →  event.screen_theme
```

**Per property, not per theme.** A round that only wants a different background shouldn't
have to restate the logo, the accent and the footer — that's how the three copies drift
apart. Unset properties inherit, exactly like CSS.

```json
// event default
{ "bg": {...}, "accent": "#E0A82E", "logo": "mark.png", "footer": null }

// round 2 — music round, only the background changes
{ "bg": { "type": "gradient", "from": "#2A1A3E", "to": "#160E24" } }

// question 2.7 — the big finish, background and accent
{ "bg": { "type": "solid", "from": "#0E1A14" }, "accent": "#4ADE80" }
```

**Resolve on the server, send the resolved theme.** The client never sees the cascade, so
there's one implementation and one place to test it.

### 20.6 Validate the resolved theme, never the layers

This is the trap the cascade creates.

A round overriding only the background, inheriting an accent from the event, can produce a
combination that **fails contrast even though neither layer fails on its own.** Validating
each layer in isolation catches nothing.

- Resolve and validate every question's theme at save time — 30 combinations is trivial to
  compute.
- Show the failures as a list with the question numbers, not a blocking error. Someone
  mid-edit shouldn't be trapped.
- Refuse to activate an event with a failing resolved theme.

### 20.7 Changing 30 times a night is a real risk

A theme that changes per question means the projector shifts 30 times in front of a room.

- **Apply the theme when the question becomes current (`PENDING`), not at `OPEN`.** The
  change lands during the lull rather than at the moment everyone looks up.
- Crossfade over ~400ms. Never a hard cut, never a flash.
- Honour `prefers-reduced-motion` on the screen client — instant swap, no fade.
- Warn in admin when consecutive questions differ sharply in luminance. Dark-to-light-to-
  dark across three questions is unpleasant to sit through and is exactly the pattern
  per-question theming invites.

**Guidance, not a rule:** round-level theming suits most nights. Per-question earns its place
for a handful of moments — a picture round, a music round, the final question — not for all
thirty.

### 20.8 What each surface shows

- **Phone header band** — the team's colour. Identity, constant all night, matching the
  printed card. It never changes, because an identifier that changes isn't one.
- **Phone content, and the whole big screen** — the resolved theme, layout and colour both.
  A music round darkens the projector and every phone together, and switches both to the
  `media` layout.

### 20.9 Colour needs real tokens, not two values

A background and an accent are enough to paint a projector, which only ever renders text on
a field. A phone has an answer input, buttons, selected and unselected options, a locked
state and a confirmation line. Under a dark question theme, a default white input looks
broken.

So a theme defines:

| Token | Used for |
|---|---|
| `bg` | Page background — solid or gradient |
| `surface` | Answer options, cards, the input field |
| `surface-selected` | The chosen answer |
| `text` / `text-muted` | Body and secondary copy |
| `border` | Option outlines, dividers |
| `accent` / `accent-text` | Submit button, round labels, the leading position |

Sensible values are derived from `bg` and `accent` when a preset doesn't specify them, but
they are real tokens with real fallbacks, not guesses made at render time.

### 20.10 Contrast now has two contexts

Validation runs the resolved theme against **both** surfaces:

- Projector — 7:1, because ambient light and a dusty lens subtract.
- Phone — 4.5:1, on every token pair that puts text on a field: `text` on `bg`, `text` on
  `surface`, `accent-text` on `accent`.

Passing the projector bar usually carries the phone, but not always — an accent that's
legible as a small round label on a wall can fail as a button colour in someone's hand.
Check both, and report failures by token so it's obvious what to change.

**The header band is validated separately and once:** the team's own text against the team
colour. Its edge against the content background is a boundary, not a text contrast problem —
give it a hairline border so it reads as distinct against any theme.

### 20.11 Theme changes happen in 240 hands as well as on a wall

The churn risk from 20.7 doubles. Same mitigations, applied to the phone client too: change
at `PENDING` rather than `OPEN`, crossfade 400ms, instant under `prefers-reduced-motion`.

And the standing rule still holds — a selected answer is marked by border weight and fill,
never by colour alone, so it survives every theme in the palette.

### 20.12 Presets

Ship four: light, dark, festive, corporate. Each already passes the contrast rules.

Most people should never open the colour pickers, and the ones who do should find the
validator refusing bad combinations rather than shipping them to a wall.

Theme changes apply live and can be made mid-event — it's presentation only, so there's no
reason to lock it.

---

## 21. Settled defaults

| Setting | Default | Note |
|---|---|---|
| Timer | Off | Host controls pacing. If enabled, server-timestamped, soft cue, never auto-submits |
| Leaderboard | Every round | Top five after rounds 1 and 2, full board at the end |
| Images | Uploaded, compressed to 1200px WebP | No external URLs |
| Player poll | 3s while visible | Tune at rehearsal |
| Operator poll | 1s | One console, and the answered grid is watched closely |
| `PENDING` screen | Shows round and question number | Reassures a table their phone is working; reveals nothing |

### 21.1 Tune at rehearsal, not in code

Poll interval is the one number worth measuring on the venue's actual network. 3s is a
guess; 5s halves the traffic and probably nobody notices. It is a setting for exactly this
reason.

### 21.2 Nothing else is open

Every decision in this document is made. Anything discovered from here is a change, not a
gap — record it in the audit trail of decisions rather than treating the spec as still
forming.
