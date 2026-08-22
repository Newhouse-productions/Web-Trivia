# Enablement — plan and rationale

*Step-by-step commands are in `trivia-enablement-instructions.md`. This document explains
the shape of the approach and what it defers.*

Build the whole thing locally on Windows, exposed through a quick Cloudflare Tunnel. No
domain, no server, no DNS wait. The VPS comes later, once the app works.

Steps 1–5 are one focused evening.

---

## The decision that makes a changing hostname painless

A quick tunnel hands you a new `*.trycloudflare.com` hostname every restart. That only hurts
if the app has stored the old one.

**Never store an absolute URL. Build every URL from the incoming request.**

- The database stores **tokens**, never links.
- The QR sheet renders at request time from the current host — so it's correct the moment you
  load it, on every restart, forever.
- The join instructions on the big screen do the same.

Do this and a restart costs you one thing only: re-entering the passphrase on test devices,
because cookies are scoped per hostname. Everything else just works.

This isn't a workaround. It's what makes dev, VPS and any future move free.

---

## 1 · Windows toolchain

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Microsoft.VisualStudioCode
winget install Cloudflare.cloudflared
```

Also install **Visual Studio Build Tools** with the C++ workload. `better-sqlite3` usually
drops in a prebuilt binary; when it doesn't, it compiles, and finding that out mid-build is a
bad hour.

**Done when:** `node -v` is 20+, `cloudflared --version` works.

---

## 2 · Repo skeleton

```
trivia/
  CLAUDE.md                 ← invariants, read by every Claude Code session
  docs/
    scope.md
    technical-design.md
    architecture-review.md
  templates/                ← xlsx and CSVs
  src/
  media/
  data/                     ← quiz.db, gitignored
```

Copy the documents in before writing code. `.gitignore`: `node_modules/`, `data/`, `media/`,
`.env`.

**Done when:** pushed, with `CLAUDE.md` at the root.

---

## 3 · Hello server, proving SQLite

```powershell
npm init -y
npm install fastify better-sqlite3
```

Twenty lines: a Fastify server on 3000, one route returning `{ ok: true }`, one that opens a
SQLite file in `data/`, writes a row and reads it back.

**Done when:** localhost:3000 responds *and* `data/test.db` holds your row. This is what
catches a native module problem while it costs nothing.

---

## 4 · Quick tunnel, and a script so restarting is cheap

```powershell
cloudflared tunnel --url http://localhost:3000
```

It prints a hostname like `https://random-words-here.trycloudflare.com`.

Write a small `dev.ps1` that starts the app and the tunnel together, captures the hostname
from cloudflared's output, and prints it large along with a QR code you can scan straight off
the screen. That turns a restart from a chore into three seconds.

**Done when:** the hello route answers on the tunnel hostname from your laptop.

---

## 5 · Prove it on a real phone

An actual phone, on mobile data, not your wifi.

1. Loads over `https://` with a valid padlock.
2. **A `Secure` cookie sets and reads back.** Add a temporary route that sets one and another
   that echoes it.
3. Lock the phone two minutes, wake it, reload — it recovers.

**Done when:** all three pass on one iPhone and one Android. An older Android tells you more
than a new one; it's what a chunk of the room will be carrying.

---

## 6 · Accept the exposure, and mitigate what you can

A trycloudflare hostname is public and **cannot sit behind Cloudflare Access** — you don't
control that zone. So:

- Passphrase and PIN gates in the app **from the first session that has any data**, not
  "later".
- Different passphrase and PINs from the live event.
- No real personal data in dev, ever.
- Stop the tunnel when you're not testing. An app on localhost is unreachable; a tunnel is not.

The hostname is long and random, so drive-by discovery is unlikely — but it is not
protection, and it should never be treated as any.

---

## 7 · Build the whole app, locally

Everything in P0 and P1 can be built and tested this way:

| Works fully locally | Notes |
|---|---|
| All four surfaces on real phones | Via the tunnel |
| SQLite, migrations, backups | The database is one file |
| CSV and JSON import, media upload | Same code path as production |
| Multi-device, captain handover, marking | Two or three phones is enough |
| Themes and contrast validation | Pure computation |
| Load testing | Run `autocannon` against **localhost**, not the tunnel — you want the app's numbers, not Cloudflare's |
| Pause, reopen, publish, the state machine | All server-side |

---

## 8 · Deferred risk register — things this setup cannot test

Write these down now, because they'll be invisible until VPS day and each has bitten someone.

| Deferred | Why it can't be tested here | When it lands |
|---|---|---|
| **Cloudflare caching `/v`** | No zone control, no cache rules on a quick tunnel | First VPS deploy. Set `no-store` now anyway |
| **Case-sensitive filenames** | Windows says `Opera.webp` == `opera.webp`; Linux disagrees | First VPS deploy. Lowercase every filename on upload now |
| Edge rate limiting, WAF, Access | Zone features | VPS + domain |
| Caddy, systemd, restart-on-crash, permissions | No server | VPS |
| Real domain, printed QR codes | Hostname isn't stable | VPS |
| Keep-alive through the full chain | Different path | VPS |

**The two that actually bite are the first two.** Set the cache headers and normalise
filenames while building, even though you can't verify either until the VPS exists.

---

## 9 · Claude Code

```powershell
npm install -g @anthropic-ai/claude-code
```

Run it from the repo root so it reads `CLAUDE.md`.

**Done when:** a session can answer "what are the invariants for this project" from the file
rather than from guesswork.

---

## 10 · When to stop deferring the VPS

Move to a server when any of these becomes true:

- P0 is working end to end on your phone
- You want to rehearse with people who aren't you
- You're within **two weeks** of the event

That last one is the hard line. The VPS step has DNS propagation, certificate issuance, and
possible identity verification in it — all fine with slack, all fatal on the day.

---

## Order, condensed

1. Toolchain, repo, hello server with a SQLite write
2. Quick tunnel plus a `dev.ps1` that prints the hostname and a QR
3. Phone test: HTTPS, `Secure` cookie, sleep and wake
4. Build P0, with URLs derived from the request and filenames lowercased
5. Claude Code from the repo root
6. VPS at two weeks out, or when you need to rehearse

**The one habit to hold from day one:** no absolute URLs anywhere. It's what makes the
changing hostname a non-event, and it makes the eventual move to a domain free.
