@echo off
rem ASCII-only on purpose: cmd mis-parses non-ASCII batch files (chcp is unreliable mid-file)
rem Starts the whole linked chain (kaikei-api :8000 + kanri-dwh :8100 + ETL) if available,
rem then starts this app's server hidden in the background and opens the browser.
rem Use stop.bat to stop this app's server. Linked systems can be stopped with
rem Kaikei-API-Kanri-DWH\stop_servers.bat (or just close their hidden windows).
rem The app also works when they are down - the management view just shows a note.
title Purchase Kaikei System
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)

rem ---------- Linked systems (optional, v4): kaikei-api :8000 + kanri-dwh :8100 + ETL ----------
set CHAIN_BASE=%~dp0..\..\Kaikei-API-Kanri-DWH
if not exist "%CHAIN_BASE%\kaikei-api" goto app_setup

echo Starting linked systems (kaikei-api + kanri-dwh + ETL)...

rem kaikei-api on :8000 - skip when already listening
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://localhost:8000/api/accounts' -TimeoutSec 1 -UseBasicParsing) | Out-Null; exit 1 } catch { exit 0 }" >nul 2>nul
if errorlevel 1 goto kanri_start
echo - kaikei-api (:8000)...
for /f %%i in ('powershell -NoProfile -Command "Start-Process python -ArgumentList '-m','uvicorn','kaikei_api.main:app','--app-dir','src','--port','8000' -WorkingDirectory '%CHAIN_BASE%\kaikei-api' -WindowStyle Hidden -PassThru | ForEach-Object { $_.Id }"') do echo KAIKEI_PID %%i

:kanri_start
rem kanri-dwh on :8100 - skip when already listening
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://localhost:8100/api/kpi/reconcile' -TimeoutSec 1 -UseBasicParsing) | Out-Null; exit 1 } catch { exit 0 }" >nul 2>nul
if errorlevel 1 goto wait_source
echo - kanri-dwh (:8100)...
for /f %%i in ('powershell -NoProfile -Command "Start-Process python -ArgumentList '-m','uvicorn','kanri.app:app','--port','8100' -WorkingDirectory '%CHAIN_BASE%\kanri-dwh' -WindowStyle Hidden -PassThru | ForEach-Object { $_.Id }"') do echo KANRI_PID %%i

:wait_source
rem Import the latest journal into the DWH once kaikei-api responds (best effort, up to ~20s)
powershell -NoProfile -Command "$ok=$false; for($i=0; $i -lt 40; $i++){ try { (Invoke-WebRequest -Uri 'http://localhost:8000/api/accounts' -TimeoutSec 1 -UseBasicParsing) | Out-Null; $ok=$true; break } catch { Start-Sleep -Milliseconds 500 } }; if($ok){ exit 0 } else { exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo [WARN] kaikei-api did not respond - skipping ETL ^(management view will show no data^)
  goto app_setup
)
echo - Importing journal into DWH (ETL)...
pushd "%CHAIN_BASE%\kanri-dwh"
python -m kanri etl --source http://localhost:8000 >nul 2>nul
if errorlevel 1 echo [WARN] ETL failed - management view may show no data ^(check kaikei-api^)
popd

rem ---------- This app ----------
:app_setup
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
