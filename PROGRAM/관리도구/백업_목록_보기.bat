@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
call "%~dp0..\_common.cmd"
if errorlevel 1 (
  pause
  exit /b 1
)
"%NODE_EXE%" --no-warnings "%~dp0..\server\admin.cjs" list-backups --url "%MEMORY_SUITE_SERVER_URL%"
pause
