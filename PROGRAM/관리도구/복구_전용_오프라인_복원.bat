@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0.."
call "%~dp0..\_common.cmd"
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo [주의] 서버가 정상 기동하지 못할 때만 사용하는 복구 전용 기능입니다.
echo 현재 DATA의 대상 DB 원본은 recovery-quarantine에 별도 보존됩니다.
echo.
set /p "BACKUP_ID=복원할 백업 ID를 정확히 입력하세요: "
if not defined BACKUP_ID exit /b 1
set /p "TARGET=대상 [all/flashback/hayaku/libra/lia/retrace 또는 쉼표 목록] (기본 all): "
if not defined TARGET set "TARGET=all"
set /p "CONFIRM=오프라인 복원을 실행하려면 OFFLINE-RESTORE를 입력하세요: "
if /i not "%CONFIRM%"=="OFFLINE-RESTORE" (
  echo 취소했습니다.
  pause
  exit /b 1
)
"%NODE_EXE%" --no-warnings "%~dp0..\server\admin.cjs" restore-offline "%BACKUP_ID%" "%TARGET%" --yes
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
