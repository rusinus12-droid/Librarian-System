@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
call "%~dp0..\_common.cmd"
if errorlevel 1 (
  pause
  exit /b 1
)
echo 전체 백업의 SHA-256과 SQLite integrity를 검사합니다.
"%NODE_EXE%" --no-warnings "%~dp0..\server\admin.cjs" scrub --url "%MEMORY_SUITE_SERVER_URL%"
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
