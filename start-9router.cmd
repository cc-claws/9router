@echo off
setlocal
title 9router - port 20130
cd /d "%~dp0"

echo [9router] Stopping old instance on 20130...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :20130 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1
ping -n 2 127.0.0.1 >nul

if /i "%~1"=="build" (
    echo [9router] Building...
    set CIRCLE_NODE_TOTAL=2
    set NODE_OPTIONS=--max-old-space-size=3072
    call node node_modules\next\dist\bin\next build
    if errorlevel 1 goto :buildfail
    call node scripts\copy-standalone-assets.mjs
    if errorlevel 1 goto :buildfail
    if exist ".next\standalone\node_modules\better-sqlite3" rmdir /s /q ".next\standalone\node_modules\better-sqlite3"
)

echo [9router] Starting http://localhost:20130
set PORT=20130
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList '.next\standalone\custom-server.js' -WorkingDirectory '%~dp0.' -WindowStyle Hidden -RedirectStandardOutput '%~dp0.9router.log' -RedirectStandardError '%~dp0.9router-err.log'"

for /l %%i in (1,1,30) do (
    ping -n 2 127.0.0.1 >nul
    netstat -ano | findstr :20130 | findstr LISTENING >nul && goto :ready
)
echo [9router] Startup timed out, check .9router-err.log
exit /b 1

:ready
start http://localhost:20130
echo [9router] Ready (running in background, logs: .9router.log)
exit /b 0

:buildfail
echo [9router] Build failed, not started
pause
exit /b 1
