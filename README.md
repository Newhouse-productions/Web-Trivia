# Web Trivia

A web app for running a live trivia night: about 30 tables and 240 phones, for three hours.
Each table scans its own QR code; one person per table — the captain — submits answers, and
everyone else follows along on their own phone. A host runs the night from a console, the
questions and leaderboard go up on a big screen, and markers judge free-text answers as the
night goes.

Many events can be configured; exactly one runs at a time.

## What's in it

| Surface | URL | Who uses it |
|---|---|---|
| Player | `/t/<table code>` → `/play` | Everyone at a table. Passphrase, pick a name, answer (captain) or follow along |
| Host console | `/ops` → Host | Opens, closes and reveals questions; pause; bonuses; publishes each round's leaderboard |
| Marker | `/ops` → Marker | Works the free-text marking queue during play; accepts spellings for every table at once |
| Floor | `/ops` → Floor | Walks the room on a phone: who's offline, join codes, rename, reassign captain, enter answers for a table |
| Admin | `/ops` → Admin | Events, question import and editor, tables and QR sheet, media, theme, settings, audit log, backup |
| Big screen | `/screen/<screen token>` | The projector: joining instructions, questions, answer spread, leaderboard, pause card |

Admin → Events → **Show access codes** gives the passphrase, the big-screen link and the
role PINs for the current event.

## Quick start

Needs Node 20+ (LTS). Developed on Windows; `better-sqlite3` and `sharp` ship prebuilt
binaries for common platforms.

```powershell
npm install
npm run seed     # creates data/quiz.db with a demo event: 30 tables, 3 rounds
npm start        # http://localhost:3000
```

The demo event's passphrase is `amber otter`. Its PINs are host `111111`, marker `222222`,
floor `333333` and admin `444444` — dev values only. Sign in at
`http://localhost:3000/ops`, then use Admin → Tables → **Print QR sheet** for table codes.

Session cookies are `Secure` by default. Most browsers accept them on `http://localhost`, but
if sign-in doesn't stick over plain HTTP (another device on your network, say), turn that off
for local testing — or use the tunnel below, which is HTTPS:

```powershell
$env:INSECURE_COOKIES = "true"; npm start
```

### Testing on real phones

```powershell
.\dev.ps1
```

Starts the app and a Cloudflare quick tunnel (`cloudflared` must be installed), then prints
the public `https://*.trycloudflare.com` URL and a QR code. The hostname changes on every
restart — that's expected, since the app never stores an absolute URL. Phones re-enter the
passphrase after a restart.

## Configuration

Everything has a working default for local development.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server port. The app binds to `127.0.0.1` only |
| `DB_PATH` | `data/quiz.db` | SQLite database file |
| `COOKIE_SECRET` | dev-only value | Signs session cookies. **Set a real secret anywhere but your own machine.** Changing it signs everyone out |
| `INSECURE_COOKIES` | unset | `true` to allow cookies over plain HTTP |

Per-event settings (such as the question timer) live in the database and are edited in Admin.

## Running a night

1. **Admin:** import questions (`templates/questions-template.csv`, or the `.xlsx` saved as
   CSV), import tables (`templates/tables-template.csv`), upload images, set the theme and the
   number of rounds, then **Activate** the event. Activation is refused if any resolved theme
   fails contrast.
2. **Print** the QR sheet and put one card on each table.
3. **Big screen:** open the big-screen link from Show access codes on the venue laptop. It
   shows joining instructions and the passphrase until round 1 starts.
4. **Host:** the pre-flight screen checks questions, themes and tables checked in. Send the
   practice question, then start round 1. Keyboard: `Space` advances, `C` closes, `R`
   reveals, `P` pauses.
5. **Marker** works free-text answers as each question closes. **Publish round** once marking
   is done; the leaderboard goes to the big screen and phones.
6. **Admin → Backup:** download the database at every round break.

The failure runbook is in `docs/trivia-night-scope.md` §8 — print it and keep it by the host.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run seed` | **Wipes the database** and creates the demo event |
| `npm run purge` | Deletes finished events past their 30-day retention. Meant for a daily scheduled task |

## Data and backups

Not in git, by design (`.gitignore`): `data/` (the SQLite database), `media/` (uploaded
images, stored by content hash) and `.env`. Back these up separately — the database is one
file, downloadable from Admin → Backup.

Config export (Admin → Config) saves an event's questions, tables and theme as JSON, without
answers, players, codes or PINs. Importing it always creates a new draft event with fresh
codes and PINs.

## Project layout

```
src/
  server.js, app.js     Fastify server, security headers, static assets
  routes/               player, ops (host), marker, floor, admin, screen, media
  db/                   schema.sql, migrations, seed, retention purge
  queries.js            shared queries and the player payload allowlist
  theme.js              theme cascade and contrast validation
public/                 the pages: play, ops (all operator roles), screen — no build step
templates/              CSV/XLSX import templates and an example config
demo/                   a sample event package (config, logos, banner)
docs/                   scope, technical design, design handover, setup notes
Mockups/                HTML design mockups
```

Stack: Node, Fastify, SQLite (`better-sqlite3`, WAL mode), plain JavaScript in the browser,
polling rather than websockets. No frontend framework and no bundler — see `CLAUDE.md` for
why, and for the invariants that are easy to break by accident.

## Docs

- `docs/trivia-night-scope.md` — what's being built, priorities, acceptance criteria, runbook
- `docs/trivia-technical-design.md` — state machine, transport, concurrency, auth, themes
- `docs/DESIGN-HANDOVER.md` and `docs/trivia-design-system.html` — the design system
- `docs/fresh-install-setup.md` — setting up a new Windows machine
- `CLAUDE.md` — the non-negotiables, for anyone (or any AI) changing the code
