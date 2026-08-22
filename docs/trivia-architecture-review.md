# Architecture review

*22 Aug 2026 · against `trivia-technical-design.md` and `trivia-night-scope.md`*

**Status: all findings resolved in technical design v0.4.** Kept as the record of what was
found and why each fix was chosen.

Severity: **P0** blocks build · **P1** fix before the night · **P2** worth doing

---

## Security

### S1 · Table tokens leak through Referer and logs — P0

The token is in the URL path. Three leaks follow:

- The **YouTube embed** at reveal is a cross-origin iframe. The browser sends a `Referer`
  containing `/t/9f3k2m4p` to Google on every unlock.
- **Caddy and Cloudflare access logs** store full paths. Every table token ends up in
  plaintext logs, retained on someone else's infrastructure.
- Any external link, image or analytics script does the same.

**Fix**

- Send `Referrer-Policy: no-referrer` globally.
- Better: treat the token as a **bearer credential exchanged once**. On first hit,
  `/t/:token` sets the session cookie and 302s to `/play`, a path with no secret in it. The
  token then appears in exactly one log line per device instead of every request.
- Configure Caddy to strip or hash the path segment for `/t/*`.

### S2 · User content reaches the big screen with no escaping specified — P0

Team names, usernames and free-text answers are rendered on the marker screen, host console
and **the projector**. The spec never mentions escaping or sanitisation, and one of the
render paths is explicitly `innerHTML`-style templating.

A team called `<img src=x onerror=...>` runs script in the operator console — the session
with the highest privilege in the building.

**Fix**

- Escape on output, everywhere, without exception. Prefer `textContent` over `innerHTML`
  for any value that originated from a user.
- Add `Content-Security-Policy: default-src 'self'; script-src 'self'; frame-src
  https://www.youtube-nocookie.com`.
- Length-cap team names and usernames at the API, not just the UI.
- Add a hostile-input row to the dry run: a team name containing angle brackets, quotes and
  an emoji.

### S3 · Per-session rate limiting on PINs is trivially bypassed — P0

§7.4 correctly rejects per-IP limiting because the venue shares one NAT address, and keys
the limit on a session cookie instead. But an attacker discards the cookie and gets a fresh
bucket. The limit constrains honest users only.

**Fix**

- Keep per-session limiting for honest mistyping.
- Add a **global per-role counter**: after N failures across all sessions in a window, lock
  that role's PIN and require an admin unlock. Set N high enough to absorb the room —
  operators are few, so a global lock on the Host PIN is a rare event.
- Raise PINs to 6 digits. Four digits is 10,000 guesses; at 5/second that's under an hour.
- Log failures with the reason, and surface a count in admin. Ten failures on the Admin PIN
  is worth noticing.

### S4 · Media gating and CDN caching are in direct conflict — P1

§7.1 says media isn't served until its question opens. §8.5 says long cache headers on
`/media`. Both cannot be true: if Caddy or Cloudflare serves the file, Node can't enforce the
gate; if Node enforces the gate, the CDN can't cache and 240 phones hit the origin for the
same image at once.

**Fix**

- Drop state-gating. Use **unguessable filenames** instead: `/media/<sha256>.webp`. The file
  listing stops being a preview of the night because there's nothing to enumerate.
- Keep directory listing off, long cache TTL on, and let the CDN absorb the burst.
- This is the same trade as the screen token — an unguessable URL, not an access check.

### S5 · CSRF is covered but not stated — P2

`SameSite=Lax` blocks cross-site POST, which is the whole attack surface here. Say so
explicitly so nobody "improves" it to `None` later while debugging an embed.

### S6 · Upload validation is unspecified — P1

Admin accepts image uploads and CSV/JSON imports with no stated limits.

**Fix**

- Cap upload size (5 MB), sniff the real MIME type rather than trusting the extension, cap
  decoded dimensions before passing to `sharp`, and cap CSV rows (500) and JSON size.
- Reject anything that isn't a recognised image after decode.

---

## Scalability

### C1 · A single global version number wakes every device for every change — P0

`/v` returns one integer for the whole event. That means a bonus awarded to table 4, a
username added at table 19, or a captain handover at table 27 all bump the version — and all
240 devices then fetch a 2 KB snapshot.

At a busy moment that's a synchronised 500 KB burst triggered by an event that concerned one
table.

**Fix**

- Split the counter: `version = max(event_version, table_version)`. Event-wide changes
  (question state, publish) bump the first; table-local changes (answer, captain, names) bump
  only that table's.
- `/v/:token` returns the max of the two. Costs one extra column and one extra read.
- Without this the design is still *survivable* at 30 tables — but it's a one-line fix now
  and a refactor later.

### C2 · Synchronised polling has no jitter — P1

Every client polls on a fixed 3-second interval. After a server restart or a network blip,
all 240 retry in lockstep and stay in lockstep, producing a repeating spike instead of a
flat 80 req/s.

**Fix**

- Jitter the interval: `3000 ± 500ms`, re-randomised each cycle.
- Exponential backoff on failure, capped at ~15s, with jitter — otherwise a restarting
  server gets hammered by 240 clients at the exact moment it's least able to respond.

### C3 · The image burst at question open is the real bandwidth event — P2

240 devices fetching a 100 KB image within one poll cycle is ~24 MB in about three seconds.
Fine on a VPS behind a CDN; not fine served from Node on a home connection.

**Fix**

- Confirm images are CDN-cached (follows from S4's hashed filenames).
- Keep the 1200px / WebP compression target; reject anything that would exceed ~150 KB.

### C4 · No connection reuse mentioned — P2

At 80 req/s, TLS handshakes dominate cost if keep-alive isn't working.

**Fix** — verify keep-alive end to end (Cloudflare → Caddy → Node) during the load test, and
assert it in the `autocannon` run.

---

## Missing edge cases

### E1 · A finished or deactivated event still has phones polling it — P1

Multi-event introduced `active` state, but nothing specifies what a table token resolves to
when its event is finished, archived, or deactivated mid-night.

**Fix** — return a clear terminal state (`event_not_running`) that the client renders as a
plain message. Never 404 (looks broken), never stale state (looks live).

### E2 · Marking lease expiry mid-judgement — P1

The 2-minute lease renews "on marking activity". A marker deliberating over one awkward
answer for three minutes loses the claim silently, another marker picks it up, and the alias
hazard from §6.3 reappears.

**Fix**

- Renew on *any* interaction, including keystrokes and scrolls, not just on a mark.
- Warn the holder at 20 seconds remaining with a one-tap extend.
- Store the lease in SQLite, not memory, or a process restart drops every claim.

### E3 · Host reopens a question while a marker holds it — P1

Two legitimate actors, opposite directions, unspecified outcome.

**Fix** — reopening force-releases the claim and notifies the marker with the reason. The
host action wins; the marker is told why their screen changed.

### E4 · An answer submitted in the same instant as close — P2

The server rejects it correctly, but the captain sees their answer vanish with no
explanation.

**Fix** — return a distinct code and render "The question closed before your answer arrived."
A rejection that looks like a bug is a bug.

### E5 · Late-arriving tables — P2

A table that joins in round 2 scores zero for round 1 and sits at the bottom of the board.
Not wrong, but undecided.

**Fix** — mark the table with a joined-at-round and exclude it from countback comparisons, or
explicitly accept the zero. Decide before someone asks at the bar.

### E6 · Duplicate usernames at a table — P2

Two people called Dave. The picker becomes ambiguous and attribution meaningless.

**Fix** — reject an exact duplicate at the API with a suggestion ("Dave 2").

### E7 · Duplicate order numbers created by editing — P2

Import validates for duplicates; the admin editor doesn't.

**Fix** — validate on save, not just on import.

---

## Failure modes

### F1 · Version increment must be atomic — P1

The counter is read-modify-written by concurrent requests. With `better-sqlite3` this is
easy to get right and easy to get wrong.

**Fix** — increment inside the same transaction as the state change, using
`UPDATE ... SET version = version + 1 RETURNING version`. Never read-then-write in
application code.

### F2 · Signing-salt rotation must degrade gracefully — P2

Rotating the salt invalidates every session. If the client renders the resulting 401 as an
error, the room sees breakage rather than a passphrase prompt.

**Fix** — any 401 on a player route redirects to the gate. Rotation should look like
"enter the passphrase again", not like an outage.

### F3 · Disk exhaustion has no detection — P2

SQLite write failures under a full disk surface as generic errors mid-event.

**Fix** — pre-flight checks free space and refuses to start below a threshold; media uploads
check before writing.

---

## Documentation

- The technical design is still titled *"state machine and resync"* and marked **v0.1**,
  while covering auth, stack, admin, accessibility, multi-event and dev environment. Retitle
  and version it — the scope doc already drifted once for exactly this reason.
- §1 still says "Assume one host" while §16 establishes multi-event and five roles.
  Reconcile.

---

## Overall

The design is sound. The state machine, the absolute-command rule, the snapshot-not-patch
decision and derived scoring are all correct and mutually consistent, and several of the
hardest problems have already been designed out rather than managed.

The gaps cluster in two places, both predictable: **things that only exist once real
untrusted input arrives** (S1, S2, S3, S6), and **things that only exist once there is more
than one of something** (C1, E1, E2, E3).

Fix the four P0s before writing feature code — each is cheap now and structural later.
