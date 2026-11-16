# Starts the transcriber on http://127.0.0.1:8765 (the built page is served from the same address).
# Usage:  .\backend\run.ps1            (from the project folder)
#         .\backend\run.ps1 -Dev       (hot reload, like nodemon: restarts when a backend .py file changes,
#                                       after any running export, voice job, Claude turn or transcription)
#         $env:WHISPER_MODEL = "base"; .\backend\run.ps1   (pick a faster or more accurate speech model)
param([switch]$Dev)
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
  Write-Host "No Python environment yet. Run backend\setup.ps1 first." -ForegroundColor Yellow
  exit 1
}
Write-Host "Video Transcriber: open http://127.0.0.1:8765" -ForegroundColor Green
if ($Dev) {
  Write-Host "Hot reload is on: a change to a backend .py file restarts the server (type rs + Enter to restart now)." -ForegroundColor Cyan
  & $python dev.py
} else {
  & $python app.py
}
