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
rem Server access mode: remote / local / rotate / show. The server must be stopped to change it;
rem a change applies from the next server start.
set "MEMORY_SUITE_REMOTE_ACTION=%~1"
if defined MEMORY_SUITE_REMOTE_ACTION goto run
echo 서버 접속 모드를 바꿉니다.
echo   내부 접속 모드(기본): 이 PC의 플러그인만 키 없이 연결합니다.
echo   원격 접속 모드: 모든 플러그인이 접근 키로 연결합니다. 다른 기기는 Tailscale이나 Cloudflare Tunnel을 거쳐야 합니다.
echo 바꾸기 전에 서버를 꺼 주세요. 실행 중이면 먼저 2_서버_종료.bat을 실행하세요.
echo.
echo   1. 원격 접속 모드 켜기 (접근 키를 만들고 보여 줍니다)
echo   2. 내부 접속 모드로 돌아가기 (접근 키는 보존)
echo   3. 접근 키 새로 만들기 (예전 키는 더 이상 쓸 수 없습니다)
echo   4. 현재 모드와 접근 키 보기
set /p "MEMORY_SUITE_REMOTE_CHOICE=번호를 고르세요 (1~4): "
if "%MEMORY_SUITE_REMOTE_CHOICE%"=="1" set "MEMORY_SUITE_REMOTE_ACTION=remote"
if "%MEMORY_SUITE_REMOTE_CHOICE%"=="2" set "MEMORY_SUITE_REMOTE_ACTION=local"
if "%MEMORY_SUITE_REMOTE_CHOICE%"=="3" set "MEMORY_SUITE_REMOTE_ACTION=rotate"
if "%MEMORY_SUITE_REMOTE_CHOICE%"=="4" set "MEMORY_SUITE_REMOTE_ACTION=show"
if not defined MEMORY_SUITE_REMOTE_ACTION (
  echo 1~4 중 하나를 입력하세요.
  pause
  exit /b 2
)
:run
"%NODE_EXE%" --no-warnings "%MEMORY_SUITE_PROGRAM_DIR%\tools\platform_launcher.cjs" set-remote-access --%MEMORY_SUITE_REMOTE_ACTION% --data-dir "%MEMORY_SUITE_DATA_DIR%"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXIT_CODE%
