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
rem Remote access (Docker, other devices): enable / disable / rotate / show. The server must be stopped to change it.
set "MEMORY_SUITE_REMOTE_ACTION=%~1"
if defined MEMORY_SUITE_REMOTE_ACTION goto run
echo 다른 기기나 Docker 컨테이너의 플러그인이 이 서버에 접속하도록 허용합니다.
echo 바꾸기 전에 서버를 꺼 주세요. 실행 중이면 먼저 2_서버_종료.bat을 실행하세요.
echo.
echo   1. 외부 접속 켜기 (접근 키를 만들고 보여 줍니다)
echo   2. 외부 접속 끄기
echo   3. 접근 키 새로 만들기 (예전 키는 더 이상 쓸 수 없습니다)
echo   4. 현재 상태와 접근 키 보기
set /p "MEMORY_SUITE_REMOTE_CHOICE=번호를 고르세요 (1~4): "
if "%MEMORY_SUITE_REMOTE_CHOICE%"=="1" set "MEMORY_SUITE_REMOTE_ACTION=enable"
if "%MEMORY_SUITE_REMOTE_CHOICE%"=="2" set "MEMORY_SUITE_REMOTE_ACTION=disable"
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
