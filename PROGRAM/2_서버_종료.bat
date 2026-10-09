@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "MEMORY_SUITE_NODE_ONLY=1"
call "%~dp0_common.cmd"
if errorlevel 1 (
  if defined MEMORY_SUITE_STARTUP_ERROR_LOG echo 진단 로그: %MEMORY_SUITE_STARTUP_ERROR_LOG%
  pause
  exit /b 1
)
"%NODE_EXE%" --no-warnings "%MEMORY_SUITE_PROGRAM_DIR%\tools\platform_launcher.cjs" stop --data-dir "%MEMORY_SUITE_DATA_DIR%"
set "EXIT_CODE=%ERRORLEVEL%"
if not errorlevel 1 (
  echo.
  echo 안전 종료를 요청했습니다. 변경된 데이터는 종료 전에 자동 백업됩니다.
)
timeout /t 2 /nobreak >nul
pause
exit /b %EXIT_CODE%
