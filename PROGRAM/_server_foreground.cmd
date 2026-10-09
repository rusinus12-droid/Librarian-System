@echo off
chcp 65001 >nul
setlocal
title Librarian System Data Server
cd /d "%~dp0"

set "MEMORY_SUITE_EARLY_LOG=%TEMP%\memory-suite-launch-%RANDOM%-%RANDOM%.log"
>"%MEMORY_SUITE_EARLY_LOG%" echo [%DATE% %TIME%] foreground launcher start
>>"%MEMORY_SUITE_EARLY_LOG%" echo PROGRAM="%~dp0"

if not exist "%~dp0_common.cmd" (
  echo.
  echo [Librarian System] _common.cmd를 찾을 수 없습니다.
  echo ZIP 안에서 직접 실행하지 말고 전체 폴더를 먼저 압축 해제하세요.
  echo 진단 로그: %MEMORY_SUITE_EARLY_LOG%
  >>"%MEMORY_SUITE_EARLY_LOG%" echo ERROR=missing_common_cmd
  exit /b 2
)

set "MEMORY_SUITE_NODE_ONLY=1"
call "%~dp0_common.cmd"
if errorlevel 1 (
  echo.
  echo 서버 준비에 실패했습니다. 위에 표시된 단계와 원인을 확인하세요.
  if defined MEMORY_SUITE_STARTUP_ERROR_LOG echo 진단 로그: %MEMORY_SUITE_STARTUP_ERROR_LOG%
  if not defined MEMORY_SUITE_STARTUP_ERROR_LOG echo 초기 진단 로그: %MEMORY_SUITE_EARLY_LOG%
  exit /b 3
)

echo.
echo Librarian System 서버를 실행합니다.
echo PROGRAM: %MEMORY_SUITE_PROGRAM_DIR%
echo DATA:    %MEMORY_SUITE_DATA_DIR%
echo.
echo 이 창을 닫지 마세요. 종료할 때는 2_서버_종료.bat를 사용하세요.
echo DATA 폴더를 직접 복사하려면 반드시 서버를 먼저 종료하세요.
echo.
>>"%MEMORY_SUITE_EARLY_LOG%" echo [%DATE% %TIME%] starting unified launcher
"%NODE_EXE%" --no-warnings "%MEMORY_SUITE_PROGRAM_DIR%\tools\platform_launcher.cjs" serve --data-dir "%MEMORY_SUITE_DATA_DIR%"
set "EXIT_CODE=%ERRORLEVEL%"
>>"%MEMORY_SUITE_EARLY_LOG%" echo [%DATE% %TIME%] server exit=%EXIT_CODE%
echo.
echo 서버가 종료되었습니다. 종료 코드: %EXIT_CODE%
if not "%EXIT_CODE%"=="0" (
  echo 시작 진단: %MEMORY_SUITE_STARTUP_LOG%
  echo 초기 실행 로그: %MEMORY_SUITE_EARLY_LOG%
)
exit /b %EXIT_CODE%
