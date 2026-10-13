@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0.."
call "%~dp0..\_common.cmd"
if errorlevel 1 (
  pause
  exit /b 1
)
echo 현재 백업 목록:
"%NODE_EXE%" --no-warnings "%~dp0..\server\admin.cjs" list-backups --url "%MEMORY_SUITE_SERVER_URL%"
echo.
set "BACKUP_ID="
set "TARGET="
set "CONFIRM="
set /p "BACKUP_ID=복원할 백업 ID를 정확히 입력하세요: "
if not defined BACKUP_ID (
  echo 백업 ID를 입력하지 않아 종료합니다.
  pause
  exit /b 1
)
set /p "TARGET=대상 [all/flashback/hayaku/libra/lia/retrace 또는 쉼표 목록] (기본 all): "
if not defined TARGET set "TARGET=all"
echo.
echo 복원 계획을 먼저 검증합니다.
"%NODE_EXE%" --no-warnings "%~dp0..\server\admin.cjs" restore-plan "%BACKUP_ID%" "%TARGET%" --url "%MEMORY_SUITE_SERVER_URL%"
if errorlevel 1 (
  echo 복원 계획 검증에 실패했습니다.
  pause
  exit /b 1
)
echo.
echo 선택한 데이터가 백업 시점으로 교체됩니다. 복원 직전 백업은 자동 생성됩니다.
set /p "CONFIRM=계속하려면 RESTORE를 입력하세요: "
if /i not "%CONFIRM%"=="RESTORE" (
  echo 취소했습니다.
  pause
  exit /b 1
)
"%NODE_EXE%" --no-warnings "%~dp0..\server\admin.cjs" restore "%BACKUP_ID%" "%TARGET%" --url "%MEMORY_SUITE_SERVER_URL%"
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
