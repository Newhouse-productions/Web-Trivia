# Work instructions — environment enablement

Windows 11, local build, quick Cloudflare Tunnel. No domain, no VPS.

Every command is copy-pasteable. Every step has a **Verify** you must pass before moving on.
Allow about two hours end to end, most of it downloads.

Code in step 4 has been run and its output checked — the expected responses shown are real.

---

## Step 1 · Install the toolchain

Open **PowerShell as Administrator**.

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Git.Git -e
winget install --id Microsoft.VisualStudioCode -e
winget install --id Cloudflare.cloudflared -e
```

Then install the C++ build tools. `better-sqlite3` normally installs a prebuilt binary, but
when your Node version has no prebuild it compiles from source, and this is what it needs.

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
  --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

**Close PowerShell and open a new one** so the PATH updates.

### Verify

```powershell
node -v          # v20.x or higher
npm -v
git --version
cloudflared --version
```

All four must return a version. If `node` isn't found after reopening, log out and back in.

---

## Step 2 · Create the repository

```powershell
cd ~\Documents
mkdir trivia
cd trivia
git init
mkdir src, docs, templates, media, data
```

Create `.gitignore`:

```powershell
@"
node_modules/
data/
media/
.env
*.log
"@ | Out-File -Encoding utf8 .gitignore
```

Copy in the four documents:

- `CLAUDE.md` → repo root
- `trivia-night-scope.md` → `docs\scope.md`
- `trivia-technical-design.md` → `docs\technical-design.md`
- `trivia-architecture-review.md` → `docs\architecture-review.md`
- `trivia-import-template.xlsx`, `questions-template.csv`, `tables-template.csv`,
  `config-example.json` → `templates\`

```powershell
git add .
git commit -m "Docs and skeleton"
```

### Verify

```powershell
dir
Get-Content CLAUDE.md -TotalCount 3
```

`CLAUDE.md` is at the root and readable.

---

## Step 3 · Install dependencies

```powershell
npm init -y
npm pkg set type=module
npm install fastify @fastify/cookie better-sqlite3
npm install --save-dev qrcode-terminal
```

### Verify

```powershell
node -e "import('better-sqlite3').then(()=>console.log('better-sqlite3 OK'))"
```

Must print `better-sqlite3 OK`. **If this fails, stop here** — it means the native module
didn't build, and nothing later will work. See Troubleshooting below.

---

## Step 4 · The smoke-test server

This proves four things at once: Fastify runs, SQLite writes in WAL mode, signed `Secure`
cookies round-trip, and URLs are derived from the request rather than stored.

Create `src\hello.js`:

```javascript
// Enablement smoke test. Proves: Fastify, SQLite, Secure cookies,
// and URLs derived from the request rather than stored.
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'data'), { recursive: true });

const db = new Database(join(ROOT, 'data', 'test.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE IF NOT EXISTS smoke (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note TEXT NOT NULL,
  at TEXT NOT NULL
)`);

const app = Fastify({ logger: false });
await app.register(cookie, { secret: 'dev-only-not-a-real-secret' });

// Invariant: never store an absolute URL. Build it from the request.
const baseUrl = (req) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.headers.host}`;
};

app.get('/', async (req) => ({
  ok: true,
  node: process.version,
  baseUrl: baseUrl(req),
  hint: 'Try /db, /cookie/set then /cookie/check, and /qr'
}));

app.get('/db', async () => {
  db.prepare('INSERT INTO smoke (note, at) VALUES (?, ?)')
    .run('enablement check', new Date().toISOString());
  const rows = db.prepare('SELECT * FROM smoke ORDER BY id DESC LIMIT 5').all();
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM smoke').get();
  return { wrote: true, total: n, latest: rows };
});

app.get('/cookie/set', async (req, reply) => {
  reply.setCookie('smoke', `set-at-${Date.now()}`, {
    path: '/',
    httpOnly: true,
    secure: true,          // requires HTTPS — the tunnel provides it
    sameSite: 'lax',
    signed: true,
    maxAge: 60 * 60 * 12
  });
  return { set: true, next: `${baseUrl(req)}/cookie/check` };
});

app.get('/cookie/check', async (req) => {
  const raw = req.cookies.smoke;
  if (!raw) return { readBack: false, why: 'No cookie. Over plain HTTP a Secure cookie is silently dropped.' };
  const un = req.unsignCookie(raw);
  return { readBack: un.valid, value: un.value };
});

app.get('/qr', async (req, reply) => {
  const url = baseUrl(req);
  reply.type('text/html');
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;padding:24px">
<h1 style="font-size:16px">Current host</h1>
<p style="font-family:ui-monospace;word-break:break-all">${url}</p>
<p>Rendered from the request. Restart the tunnel and this page is still correct.</p>`;
});

const port = Number(process.env.PORT || 3000);
await app.listen({ port, host: '127.0.0.1' });
console.log(`hello server on http://localhost:${port}`);
```

Run it:

```powershell
node src\hello.js
```

### Verify — in a second PowerShell window

```powershell
curl.exe -s localhost:3000/
curl.exe -s localhost:3000/db
```

Expected, near enough:

```json
{"ok":true,"node":"v22.x","baseUrl":"http://localhost:3000","hint":"..."}
{"wrote":true,"total":1,"latest":[{"id":1,"note":"enablement check","at":"..."}]}
```

Then confirm WAL mode actually engaged:

```powershell
dir data
```

You should see `test.db`, `test.db-shm` and `test.db-wal`. **The `-wal` file is the proof.**
Without it, WAL isn't on and a single write will block every reader at 80 requests/second.

---

## Step 5 · Start the tunnel

Leave the server running. In a second window:

```powershell
cloudflared tunnel --url http://localhost:3000
```

It prints a hostname like:

```
https://cheerful-mountain-forest-xyz.trycloudflare.com
```

### Verify

Open that URL in your desktop browser. The JSON should now show:

```json
"baseUrl":"https://cheerful-mountain-forest-xyz.trycloudflare.com"
```

**That changed value is the whole point.** Nothing was configured — the app read the host off
the request. This is why a hostname that changes every restart doesn't matter.

---

## Step 6 · Make restarting cheap

Create `dev.ps1` in the repo root:

```powershell
# Starts the app and a quick tunnel, then prints the public URL and a QR code.
$ErrorActionPreference = "Stop"

Write-Host "Starting app..." -ForegroundColor Cyan
$app = Start-Process node -ArgumentList "src\hello.js" -PassThru -NoNewWindow
Start-Sleep -Seconds 2

Write-Host "Starting tunnel..." -ForegroundColor Cyan
$log = Join-Path $env:TEMP "cloudflared.log"
if (Test-Path $log) { Remove-Item $log }
$tunnel = Start-Process cloudflared `
  -ArgumentList "tunnel","--url","http://localhost:3000","--logfile",$log `
  -PassThru -NoNewWindow

$url = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" |
         Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value; break }
  }
}

if (-not $url) {
  Write-Host "Could not find the tunnel URL. Check $log" -ForegroundColor Red
} else {
  Write-Host ""
  Write-Host "  $url" -ForegroundColor Green
  Write-Host ""
  npx --yes qrcode-terminal $url
  Set-Clipboard $url
  Write-Host "Copied to clipboard. Ctrl+C to stop both." -ForegroundColor DarkGray
}

try { Wait-Process -Id $tunnel.Id }
finally {
  Stop-Process -Id $app.Id -ErrorAction SilentlyContinue
  Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
}
```

Allow local scripts once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### Verify

```powershell
.\dev.ps1
```

A QR code appears in the terminal. Scan it with your phone camera and the JSON loads.

---

## Step 7 · The phone test — the step that matters most

Use a real phone **on mobile data**, with wifi off. Then repeat on a second phone of the
other platform.

| # | Do this | Pass looks like |
|---|---|---|
| 1 | Scan the QR from `dev.ps1` | JSON loads, padlock in the address bar |
| 2 | Visit `/cookie/set` | `{"set":true,...}` |
| 3 | Visit `/cookie/check` | `{"readBack":true,...}` |
| 4 | Lock the phone, wait 2 minutes, wake and reload | Page loads, no error |
| 5 | Visit `/qr` | Shows the tunnel hostname, not localhost |

**Step 3 is the one to care about.** A `Secure` cookie is silently dropped over plain HTTP —
no error, no warning, it simply never arrives. If it works here, every session in the real app
will work. If you skip this, you'll debug it later inside a much larger codebase.

**Test on an older Android if you can.** It's more informative than a new phone, and closer to
what a chunk of the room will be carrying.

---

## Step 8 · Install Claude Code

```powershell
npm install -g @anthropic-ai/claude-code
cd ~\Documents\trivia
claude
```

### Verify

Ask it: *"What are the invariants for this project?"*

It should answer from `CLAUDE.md` — allowlisted payloads, escaping, no absolute URLs, absolute
commands, split versioning. If it invents a general answer instead, `CLAUDE.md` isn't at the
repo root or you started Claude from the wrong directory.

---

## Step 9 · Clean up and commit

```powershell
git add .
git commit -m "Enablement: toolchain, smoke server, dev script"
```

Keep `src\hello.js` until P0 has a working player page — it's a fast way to confirm the
environment when something odd happens later.

---

## Troubleshooting

**`better-sqlite3` fails to install**
The prebuilt binary didn't match your Node version, so it tried to compile. Confirm Build
Tools installed with the C++ workload, reopen PowerShell, then:
```powershell
npm rebuild better-sqlite3 --build-from-source
```
If it still fails, install Node 20 LTS specifically — it has the widest prebuild coverage.

**`cloudflared` not recognised**
PATH hasn't refreshed. Open a new PowerShell. If it persists, log out and back in.

**Tunnel URL never appears in the log**
Corporate networks and some VPNs block the outbound QUIC connection. Force HTTP/2:
```powershell
cloudflared tunnel --url http://localhost:3000 --protocol http2
```

**Phone loads the page but `/cookie/check` says `readBack:false`**
You're on `http://`, not `https://`. Use the tunnel hostname, not your machine's LAN IP.

**`EADDRINUSE` on port 3000**
An earlier process is still running:
```powershell
Get-Process node | Stop-Process
```

**No `-wal` file in `data\`**
The pragma didn't run. Check `db.pragma('journal_mode = WAL')` executes before the first
query, and that `data\` is writable.

---

## Done when

- [ ] `node -v`, `git`, `cloudflared` all return versions
- [ ] Repo created, `CLAUDE.md` at root, docs and templates in place, committed
- [ ] `better-sqlite3` imports without error
- [ ] `/db` writes and reads, and `data\test.db-wal` exists
- [ ] Tunnel serves the app over HTTPS
- [ ] `baseUrl` in the response shows the tunnel hostname, not localhost
- [ ] `dev.ps1` prints a scannable QR
- [ ] `/cookie/set` then `/cookie/check` returns `readBack:true` **on a real phone**
- [ ] A phone locked for 2 minutes wakes and reloads cleanly
- [ ] Both an iPhone and an Android pass
- [ ] Claude Code answers the invariants question from `CLAUDE.md`

All ticked, start P0 slice 1: schema, seed tables, and `/v` plus `/state`.
