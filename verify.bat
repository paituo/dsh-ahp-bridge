@echo off
REM ============================================================
REM  DSH -> VS Code AHP bridge : one-click offline verification
REM  Pure ASCII only (requirement: .bat must be ASCII)
REM ============================================================
setlocal

set "NODE=C:\Users\liuyue\AppData\Roaming\fnm\node-versions\v24.18.0\installation\node.exe"
set "DSH_BIN=D:\JavaSofewares\npm-cache\node_modules\@deepseek-ai\dsh\lib\bin.js"
set "HERE=%~dp0"
set "BRIDGE_CWD=C:\Users\liuyue\WorkBuddy\2026-10-09-10-48-30"

if not exist "%NODE%" (
  echo [ERR] node not found: %NODE%
  exit /b 1
)
if not exist "%DSH_BIN%" (
  echo [ERR] dsh bin not found: %DSH_BIN%
  exit /b 1
)

echo ============================================================
echo  Test 1/2 : protocol e2e (handshake / thread / models / skills)
echo ============================================================
"%NODE%" "%HERE%test\e2e-bridge.mjs"
set "R1=%ERRORLEVEL%"

echo.
echo ============================================================
echo  Test 2/2 : real conversation (turn/start -> DSH -> delta)
echo ============================================================
set "VERBOSE=1"
"%NODE%" "%HERE%test\e2e-conversation.mjs"
set "R2=%ERRORLEVEL%"

echo.
echo ============================================================
if "%R1%%R2%"=="00" (
  echo  ALL PASS
) else (
  echo  SOME FAILED  ^(protocol=%R1% conversation=%R2%^)
)
echo ============================================================
endlocal
