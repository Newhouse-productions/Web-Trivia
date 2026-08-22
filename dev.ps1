# Starts the app and a quick tunnel, then prints the public URL and a QR code.
$ErrorActionPreference = "Stop"

Write-Host "Starting app..." -ForegroundColor Cyan
$app = Start-Process node -ArgumentList "src\server.js" -PassThru -NoNewWindow
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