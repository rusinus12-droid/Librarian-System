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
rem Changes the server port in DATA\config\server-config.json. The server must be stopped first.
set "MEMORY_SUITE_NEW_PORT=%~1"
if not defined MEMORY_SUITE_NEW_PORT echo 서버가 꺼진 상태에서만 포트를 바꿉니다. 실행 중이면 먼저 2_서버_종료.bat을 실행하세요.
if not defined MEMORY_SUITE_NEW_PORT set /p "MEMORY_SUITE_NEW_PORT=새 서버 포트 번호 (1024~65535): "
"%NODE_EXE%" --no-warnings "%MEMORY_SUITE_PROGRAM_DIR%\tools\platform_launcher.cjs" set-port --port "%MEMORY_SUITE_NEW_PORT%" --data-dir "%MEMORY_SUITE_DATA_DIR%"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXIT_CODE%
