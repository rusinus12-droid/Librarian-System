@echo off
chcp 65001 >nul
setlocal
title Librarian System Server Launcher
set "MEMORY_SUITE_RUNNER=%~dp0_server_foreground.cmd"

if not exist "%MEMORY_SUITE_RUNNER%" (
  echo [Librarian System] 내부 실행 파일을 찾을 수 없습니다.
  echo ZIP 안에서 직접 실행하지 말고 전체 폴더를 먼저 압축 해제하세요.
  echo 누락: %MEMORY_SUITE_RUNNER%
  pause
  exit /b 2
)

rem 같은 콘솔에서 직접 실행합니다. start/cmd 중첩 인용 오류로 새 창이
rem 즉시 닫히는 경로를 사용하지 않으며, 어떤 종료 코드든 아래에서 멈춥니다.
call "%MEMORY_SUITE_RUNNER%"
set "MEMORY_SUITE_EXIT_CODE=%ERRORLEVEL%"
echo.
if "%MEMORY_SUITE_EXIT_CODE%"=="0" (
  echo [Librarian System] 서버 실행기가 정상적으로 끝났습니다.
) else (
  echo [Librarian System] 서버를 시작하거나 유지하지 못했습니다. 종료 코드: %MEMORY_SUITE_EXIT_CODE%
  echo 위 오류 내용과 표시된 진단 로그를 확인하세요.
)
echo 이 창은 원인을 확인할 수 있도록 자동으로 닫히지 않습니다.
pause
exit /b %MEMORY_SUITE_EXIT_CODE%
