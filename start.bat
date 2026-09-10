@echo off
rem ASCII-only on purpose: cmd mis-parses non-ASCII batch files (chcp is unreliable mid-file)
rem Starts the server hidden in the background, waits until it really responds,
rem then opens the browser and closes this window. Use stop.bat to stop the server.
title Purchase Kaikei System
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First-time setup: npm install...
  call npm install
)

rem If the server is already running, just open the browser.
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://localhost:3010/api/purchases' -TimeoutSec 2 -UseBasicParsing) | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if %errorlevel%==0 (
  echo Server is already running. Opening browser...
  start "" http://localhost:3010
  timeout /t 2 >nul
  exit /b 0
)

echo Starting server in background...
set NO_OPEN=1
for /f %%i in ('powershell -NoProfile -Command "Start-Process node -ArgumentList 'server.js' -WorkingDirectory '%cd%' -WindowStyle Hidden -PassThru | ForEach-Object { $_.Id }"') do set SERVER_PID=%%i
echo %SERVER_PID%> "%TEMP%\purchase-kaikei.pid"

rem Wait (up to 10s) until the server really responds.
powershell -NoProfile -Command "$ok=$false; for($i=0; $i -lt 20; $i++){ try { (Invoke-WebRequest -Uri 'http://localhost:3010/api/purchases' -TimeoutSec 1 -UseBasicParsing) | Out-Null; $ok=$true; break } catch { Start-Sleep -Milliseconds 500 } }; if($ok){ exit 0 } else { exit 1 }" >nul 2>nul
if not %errorlevel%==0 (
  echo [ERROR] The server did not start. Try running: npm start
  pause
  exit /b 1
)

echo Server is up. Opening browser...
start "" http://localhost:3010
timeout /t 1 >nul
exit /b 0
