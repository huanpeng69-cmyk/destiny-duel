@echo off
setlocal
cd /d "%~dp0"

REM ============================================
REM  Destiny Duel - one-click launcher
REM  Double-click this file to start the game.
REM  Close this window to stop the server.
REM ============================================

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found. Please install Node.js first: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\vite" (
  echo First run detected - installing dependencies, please wait...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check your network and try again.
    pause
    exit /b 1
  )
)

REM Open the browser shortly after the server boots.
start "" cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:5173/"

echo.
echo Starting Destiny Duel at http://localhost:5173/
echo Keep this window open while playing. Press Ctrl+C or close it to stop.
echo.
call npm start

endlocal
