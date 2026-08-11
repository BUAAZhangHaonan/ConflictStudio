$ErrorActionPreference = 'Stop'

$cacheRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
$playwrightModule = Get-ChildItem -LiteralPath $cacheRoot -Directory |
  ForEach-Object { Join-Path $_.FullName 'node_modules\playwright\index.mjs' } |
  Where-Object { Test-Path -LiteralPath $_ } |
  Sort-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } -Descending |
  Select-Object -First 1

if (-not $playwrightModule) {
  throw 'Playwright runtime is not available in the existing npm cache.'
}

$env:CONFLICTSTUDIO_PLAYWRIGHT_MODULE = $playwrightModule
node scripts/browser-check.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
