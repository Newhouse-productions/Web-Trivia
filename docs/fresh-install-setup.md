# Fresh Windows install — recovery checklist

Restores dev capability on a clean Windows machine so Claude Code (and you) can pick this
project up exactly where it left off. Read alongside `CLAUDE.md` and
`docs/trivia-enablement.md` (§1 and §9 cover the same toolchain in narrative form).

---

## 0 · Before you wipe anything

**There is no git remote configured for this repo.** `git clone` will not restore it — the
only copies are wherever the folder itself lives. Confirm with `git remote -v` (empty output
means no remote).

Also gitignored, so `git` won't restore these either — back them up separately:

- `data/quiz.db` (+ `-shm`/`-wal`) — the whole database, no other copy exists
- `media/` — uploaded images, referenced by hash from the database
- `.env` — if one was ever created (none exists as of this writing; defaults are used)

**Before reinstalling Windows:** copy the entire project folder (currently `D:\Claude\trivia`)
to external storage or another drive, gitignored files included. A `git push` to a private
remote is the more durable fix if you set one up before the reinstall.

---

## 1 · Software to install

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Cloudflare.cloudflared
winget install Microsoft.VisualStudioCode      # optional, editor
npm install -g @anthropic-ai/claude-code
```

**Visual Studio Build Tools** (C++ workload) — only needed if `better-sqlite3` or `sharp`
can't find a prebuilt binary for your Node version/arch and fall back to compiling from
source. Try `npm install` first; install this only if that step fails with a `node-gyp` or
compiler error.

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
# then re-run the installer and select "Desktop development with C++"
```

### Known-good versions (this machine, 2026-08-30)

| Tool | Version |
|---|---|
| Node.js | v24.19.0 |
| npm | 11.17.0 |
| Git | 2.55.0.windows.3 |
| cloudflared | 2026.8.2 |
| OS/arch | win32 x64 |

Anything reasonably current works — Node 20+ is the actual floor (per `CLAUDE.md`: "Node
LTS"). This table is a reference point if something behaves differently on a newer install.

---

## 2 · Restore the project

1. Copy the backed-up project folder to its new location (e.g. `D:\Claude\trivia`, or wherever
   you choose — nothing in the app stores an absolute path, per `CLAUDE.md` invariant 3, so the
   location itself doesn't matter).
2. If `data/` or `media/` weren't part of the backup, they'll be missing — see §4.
3. If Git complains about the moved path:
   ```powershell
   git config --global --add safe.directory <path-to-repo>
   ```
   (Windows/git flags a repo as "dubious ownership" when it doesn't recognize the drive as
   yours — harmless, just needs the one-time exception.)

---

## 3 · Install dependencies

```powershell
cd D:\Claude\trivia
npm install
```

Installs: `fastify`, `@fastify/cookie`, `better-sqlite3`, `csv-parse`, `qrcode`, `sharp` (see
`package.json`). No `@fastify/rate-limit` currently listed despite `CLAUDE.md` naming it in
the justified-dependency set — check whether that's still pending or already folded into
custom logic before assuming it's missing by accident.

---

## 4 · Recreate data if it wasn't backed up

```powershell
npm run seed
```

Runs `src/db/seed.js` — creates `data/quiz.db` with the demo event (30 tables, 3 rounds, mixed
question types). `media/` for that seed's images will need to come from the backup or
`demo/` folder separately; seeding alone won't repopulate uploaded images.

---

## 5 · Run it

A fresh Windows account defaults `PowerShell`'s execution policy to `Restricted`, which
silently blocks `dev.ps1` from running (`... cannot be loaded because running scripts is
disabled on this system`). Allow local scripts once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

```powershell
npm start                    # app only, on localhost:3000
.\dev.ps1                    # app + Cloudflare quick tunnel + QR code
```

`dev.ps1` needs `cloudflared` on PATH (installed in §1). It prints a `*.trycloudflare.com`
URL that changes on every restart — expected, see `CLAUDE.md` invariant 3. Test devices will
need to re-enter the passphrase after each restart since cookies are scoped per hostname.

---

## 6 · Optional environment variables

None are required — every one has a working default for local dev.

| Variable | Default | Used for |
|---|---|---|
| `PORT` | `3000` | server port |
| `DB_PATH` | `data/quiz.db` | SQLite file location |
| `COOKIE_SECRET` | `dev-only-not-a-real-secret` | cookie signing — fine for local dev, never reuse for the VPS |
| `INSECURE_COOKIES` | unset (secure cookies on) | set to `true` only if testing over plain HTTP without a tunnel |

---

## 7 · Verify

- [ ] `node -v` → 20+
- [ ] `git -C D:\Claude\trivia log --oneline -3` → shows real commit history, not empty
- [ ] `cloudflared --version` → works
- [ ] `npm start` → `http://localhost:3000` responds
- [ ] `.\dev.ps1` → prints a public HTTPS URL and a scannable QR code
- [ ] Claude Code, run from the repo root, can answer "what are the invariants for this
      project" from `CLAUDE.md` rather than guessing

---

## 8 · Known gaps to pick up

- **Rate limiting is unbuilt.** `CLAUDE.md` invariant 10 requires two layers — per-session
  backoff for honest errors, plus a global per-role lockout counter for actual attacks, never
  per-IP (240 phones share one NAT address). Neither exists yet: `@fastify/rate-limit` isn't
  in `package.json`, and there's no rate-limiting code anywhere in `src/`. Pick this up on
  re-import.

## 9 · Claude Code session continuity

Session transcripts are **not** part of the repo — they live under
`%USERPROFILE%\.claude\projects\<encoded-project-path>\`. A Windows reinstall wipes them
unless backed up separately (they were backed up to `D:\Claude\backups\` on 2026-08-30 for the
session active at that time — check there first).

Note the encoded path is derived from the project's filesystem location — if the project
moves again, Claude Code will start a new project-history bucket at the new encoded path
rather than finding the old one automatically.
