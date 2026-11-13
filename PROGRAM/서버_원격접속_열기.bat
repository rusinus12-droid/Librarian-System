@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.." || exit /b 1
set "MEMORY_SUITE_NODE_ONLY=1"
call "%~dp0_common.cmd"
if errorlevel 1 (
  if defined MEMORY_SUITE_STARTUP_ERROR_LOG echo 진단 로그: %MEMORY_SUITE_STARTUP_ERROR_LOG%
  pause
  exit /b 1
)
rem Other devices reach this server through Tailscale (tailscale serve): open / close / status.
rem The server keeps listening on 127.0.0.1; Tailscale forwards https://<this PC>.<tailnet>.ts.net to it.
set "MEMORY_SUITE_TUNNEL_ACTION=%~1"
set "MEMORY_SUITE_TUNNEL_EXTRA=%~2"
if defined MEMORY_SUITE_TUNNEL_ACTION goto run
echo 다른 기기(폰, 다른 PC)가 Tailscale로 이 서버에 접속하도록 엽니다.
echo 이 PC와 접속할 기기에 Tailscale을 설치하고 같은 계정으로 로그인해 두세요.
echo.
echo   1. 열기 (원격 접속 모드가 꺼져 있으면 켤지 묻습니다)
echo   2. 닫기
echo   3. 상태 보기
echo   4. Docker 서버용으로 열기
set /p "MEMORY_SUITE_TUNNEL_CHOICE=번호를 고르세요 (1~4): "
if "%MEMORY_SUITE_TUNNEL_CHOICE%"=="1" set "MEMORY_SUITE_TUNNEL_ACTION=open"
if "%MEMORY_SUITE_TUNNEL_CHOICE%"=="2" set "MEMORY_SUITE_TUNNEL_ACTION=close"
if "%MEMORY_SUITE_TUNNEL_CHOICE%"=="3" set "MEMORY_SUITE_TUNNEL_ACTION=status"
if "%MEMORY_SUITE_TUNNEL_CHOICE%"=="4" (
  set "MEMORY_SUITE_TUNNEL_ACTION=open"
  set "MEMORY_SUITE_TUNNEL_EXTRA=docker"
)
if not defined MEMORY_SUITE_TUNNEL_ACTION (
  echo 1~4 중 하나를 입력하세요.
  pause
  exit /b 2
)
:run
if defined MEMORY_SUITE_TUNNEL_EXTRA (
  "%NODE_EXE%" --no-warnings "%MEMORY_SUITE_PROGRAM_DIR%\tools\platform_launcher.cjs" remote-tunnel --%MEMORY_SUITE_TUNNEL_ACTION% --%MEMORY_SUITE_TUNNEL_EXTRA% --data-dir "%MEMORY_SUITE_DATA_DIR%"
) else (
  "%NODE_EXE%" --no-warnings "%MEMORY_SUITE_PROGRAM_DIR%\tools\platform_launcher.cjs" remote-tunnel --%MEMORY_SUITE_TUNNEL_ACTION% --data-dir "%MEMORY_SUITE_DATA_DIR%"
)
set "EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXIT_CODE%
