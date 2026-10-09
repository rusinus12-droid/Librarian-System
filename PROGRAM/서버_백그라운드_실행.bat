@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "MEMORY_SUITE_NODE_ONLY=1"
call "%~dp0_common.cmd"
if errorlevel 1 (
  pause
  exit /b 1
)
"%NODE_EXE%" --no-warnings "%MEMORY_SUITE_PROGRAM_DIR%\tools\platform_launcher.cjs" background --data-dir "%MEMORY_SUITE_DATA_DIR%"
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
