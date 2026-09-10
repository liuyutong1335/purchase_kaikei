@echo off
rem ASCII-only on purpose: cmd mis-parses non-ASCII batch files (chcp is unreliable mid-file)
title Purchase Kaikei System - Stop
set PIDFILE=%TEMP%\purchase-kaikei.pid

if exist "%PIDFILE%" (
  set /p SERVER_PID=<"%PIDFILE%"
  taskkill /PID %SERVER_PID% /F >nul 2>nul
  del "%PIDFILE%" >nul 2>nul
)

rem Fallback: stop anything still listening on port 3010.
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3010 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }" >nul 2>nul

echo Server stopped.
timeout /t 2 >nul
exit /b 0
