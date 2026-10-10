@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0.."
call "%~dp0..\_common.cmd"
if errorlevel 1 (
  pause
  exit /b 1
)
"%NODE_EXE%" --no-warnings "%~dp0..\server\admin.cjs" list-backups --url "%MEMORY_SUITE_SERVER_URL%"
echo.
set /p "BACKUP_ID=검토할 백업 ID를 정확히 입력하세요: "
if not defined BACKUP_ID exit /b 1
set /p "TARGET=대상 [all/flashback/hayaku/libra/lia/retrace 또는 쉼표 목록] (기본 all): "
if not defined TARGET set "TARGET=all"
"%NODE_EXE%" --no-warnings "%~dp0..\server\admin.cjs" restore-plan "%BACKUP_ID%" "%TARGET%" --url "%MEMORY_SUITE_SERVER_URL%"
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
