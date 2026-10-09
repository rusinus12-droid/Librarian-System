@echo off
set "MEMORY_SUITE_BOOTSTRAP_ERROR="
set "MEMORY_SUITE_BOOTSTRAP_STAGE=paths"
set "MEMORY_SUITE_BOOTSTRAP_EXIT=1"

rem Normalize PROGRAM without its trailing backslash before passing it to Node.js.
for %%I in ("%~dp0.") do set "MEMORY_SUITE_PROGRAM_DIR=%%~fI"
for %%I in ("%MEMORY_SUITE_PROGRAM_DIR%\..") do set "MEMORY_SUITE_ROOT_DIR=%%~fI"
set "MEMORY_SUITE_DATA_DIR=%MEMORY_SUITE_ROOT_DIR%\DATA"

rem Do not touch DATA before prepare_data verifies that this PROGRAM supports it.
set "MEMORY_SUITE_TEMP_STARTUP_LOG=%TEMP%\memory-suite-startup-%RANDOM%-%RANDOM%.log"
set "MEMORY_SUITE_STARTUP_LOG=%MEMORY_SUITE_TEMP_STARTUP_LOG%"
set "MEMORY_SUITE_STARTUP_ERROR_LOG=%MEMORY_SUITE_TEMP_STARTUP_LOG%"
>"%MEMORY_SUITE_TEMP_STARTUP_LOG%" echo [%DATE% %TIME%] bootstrap start
>>"%MEMORY_SUITE_TEMP_STARTUP_LOG%" echo PROGRAM="%MEMORY_SUITE_PROGRAM_DIR%"
>>"%MEMORY_SUITE_TEMP_STARTUP_LOG%" echo DATA="%MEMORY_SUITE_DATA_DIR%"

echo [1/4] Node.js 22 이상 런타임을 확인합니다.
set "MEMORY_SUITE_BOOTSTRAP_STAGE=Node.js 확인"
call "%MEMORY_SUITE_PROGRAM_DIR%\_find_node.bat"
if not errorlevel 1 goto :node_ready

echo 포터블 Node.js 22 런타임을 PROGRAM 안에 설치합니다.
echo 다운로드와 검증이 끝날 때까지 잠시 기다려 주세요.
set "MEMORY_SUITE_BOOTSTRAP_STAGE=Node.js 설치"
set "MEMORY_SUITE_INSTALL_LOG=%TEMP%\memory-suite-runtime-%RANDOM%-%RANDOM%.log"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%MEMORY_SUITE_PROGRAM_DIR%\tools\install_runtime.ps1" >"%MEMORY_SUITE_INSTALL_LOG%" 2>&1
set "MEMORY_SUITE_STEP_EXIT=%ERRORLEVEL%"
if exist "%MEMORY_SUITE_INSTALL_LOG%" type "%MEMORY_SUITE_INSTALL_LOG%"
if exist "%MEMORY_SUITE_INSTALL_LOG%" type "%MEMORY_SUITE_INSTALL_LOG%" >>"%MEMORY_SUITE_TEMP_STARTUP_LOG%"
if not "%MEMORY_SUITE_STEP_EXIT%"=="0" (
  set "MEMORY_SUITE_BOOTSTRAP_ERROR=포터블 Node.js 설치 스크립트가 실패했습니다."
  set "MEMORY_SUITE_BOOTSTRAP_EXIT=11"
  goto :bootstrap_failed
)
if exist "%MEMORY_SUITE_INSTALL_LOG%" del /q "%MEMORY_SUITE_INSTALL_LOG%" >nul 2>&1
set "MEMORY_SUITE_INSTALL_LOG="

rem Defender may inspect a freshly-created executable for a moment.
set "MEMORY_SUITE_BOOTSTRAP_STAGE=Node.js 설치 후 확인"
set "MEMORY_SUITE_NODE_RETRY=0"
:node_retry
set /a MEMORY_SUITE_NODE_RETRY+=1 >nul
call "%MEMORY_SUITE_PROGRAM_DIR%\_find_node.bat"
if not errorlevel 1 goto :node_ready
if "%MEMORY_SUITE_NODE_RETRY%"=="5" (
  set "MEMORY_SUITE_BOOTSTRAP_ERROR=Node.js가 설치되었지만 실행 확인에 실패했습니다. Windows 보안 차단 여부를 확인하세요. %MEMORY_SUITE_NODE_ERROR%"
  set "MEMORY_SUITE_BOOTSTRAP_EXIT=12"
  goto :bootstrap_failed
)
timeout /t 1 /nobreak >nul 2>&1
goto :node_retry

:node_ready
echo [1/4] Node.js 준비 완료: %NODE_EXE%
>>"%MEMORY_SUITE_TEMP_STARTUP_LOG%" echo [%DATE% %TIME%] node ready source=%NODE_SOURCE% path="%NODE_EXE%"
if /i "%MEMORY_SUITE_NODE_ONLY%"=="1" goto :node_only_ready

set "MEMORY_SUITE_BOOTSTRAP_STAGE=DATA 준비/마이그레이션"
echo [2/4] DATA 폴더와 데이터 형식을 확인합니다.
set "MEMORY_SUITE_PREPARE_OUT=%TEMP%\memory-suite-prepare-%RANDOM%-%RANDOM%.json"
set "MEMORY_SUITE_PREPARE_ERR=%TEMP%\memory-suite-prepare-%RANDOM%-%RANDOM%.err"
"%NODE_EXE%" --no-warnings "%MEMORY_SUITE_PROGRAM_DIR%\tools\prepare_data.cjs" --program-dir "%MEMORY_SUITE_PROGRAM_DIR%" --data-dir "%MEMORY_SUITE_DATA_DIR%" >"%MEMORY_SUITE_PREPARE_OUT%" 2>"%MEMORY_SUITE_PREPARE_ERR%"
set "MEMORY_SUITE_STEP_EXIT=%ERRORLEVEL%"
if not "%MEMORY_SUITE_STEP_EXIT%"=="0" (
  if exist "%MEMORY_SUITE_PREPARE_ERR%" type "%MEMORY_SUITE_PREPARE_ERR%"
  if exist "%MEMORY_SUITE_PREPARE_OUT%" type "%MEMORY_SUITE_PREPARE_OUT%" >>"%MEMORY_SUITE_TEMP_STARTUP_LOG%"
  if exist "%MEMORY_SUITE_PREPARE_ERR%" type "%MEMORY_SUITE_PREPARE_ERR%" >>"%MEMORY_SUITE_TEMP_STARTUP_LOG%"
  set "MEMORY_SUITE_BOOTSTRAP_ERROR=DATA 준비 또는 데이터 형식 검사가 실패했습니다. DATA는 의도적으로 삭제하지 않았습니다."
  set "MEMORY_SUITE_BOOTSTRAP_EXIT=13"
  goto :bootstrap_failed
)

rem DATA is supported and prepared; persistent startup logs are now safe.
if not exist "%MEMORY_SUITE_DATA_DIR%\logs" mkdir "%MEMORY_SUITE_DATA_DIR%\logs" >nul 2>&1
set "MEMORY_SUITE_STARTUP_LOG=%MEMORY_SUITE_DATA_DIR%\logs\startup.log"
set "MEMORY_SUITE_STARTUP_ERROR_LOG=%MEMORY_SUITE_DATA_DIR%\logs\startup-error.log"
if exist "%MEMORY_SUITE_TEMP_STARTUP_LOG%" type "%MEMORY_SUITE_TEMP_STARTUP_LOG%" >>"%MEMORY_SUITE_STARTUP_LOG%"
if exist "%MEMORY_SUITE_PREPARE_OUT%" type "%MEMORY_SUITE_PREPARE_OUT%" >>"%MEMORY_SUITE_STARTUP_LOG%"
if exist "%MEMORY_SUITE_TEMP_STARTUP_LOG%" del /q "%MEMORY_SUITE_TEMP_STARTUP_LOG%" >nul 2>&1
if exist "%MEMORY_SUITE_PREPARE_OUT%" del /q "%MEMORY_SUITE_PREPARE_OUT%" >nul 2>&1
if exist "%MEMORY_SUITE_PREPARE_ERR%" del /q "%MEMORY_SUITE_PREPARE_ERR%" >nul 2>&1
set "MEMORY_SUITE_PREPARE_OUT="
set "MEMORY_SUITE_PREPARE_ERR="
echo [2/4] DATA 준비 완료: %MEMORY_SUITE_DATA_DIR%

set "MEMORY_SUITE_BOOTSTRAP_STAGE=서버 설정"
echo [3/4] 서버 설정을 읽습니다.
set "MEMORY_SUITE_ENV_FILE=%TEMP%\memory-suite-env-%RANDOM%-%RANDOM%.cmd"
set "MEMORY_SUITE_CONFIG_ERR=%TEMP%\memory-suite-config-%RANDOM%-%RANDOM%.err"
"%NODE_EXE%" --no-warnings "%MEMORY_SUITE_PROGRAM_DIR%\tools\config_env.cjs" --data-dir "%MEMORY_SUITE_DATA_DIR%" --out "%MEMORY_SUITE_ENV_FILE%" 2>"%MEMORY_SUITE_CONFIG_ERR%"
set "MEMORY_SUITE_STEP_EXIT=%ERRORLEVEL%"
if not "%MEMORY_SUITE_STEP_EXIT%"=="0" (
  if exist "%MEMORY_SUITE_CONFIG_ERR%" type "%MEMORY_SUITE_CONFIG_ERR%"
  if exist "%MEMORY_SUITE_CONFIG_ERR%" type "%MEMORY_SUITE_CONFIG_ERR%" >>"%MEMORY_SUITE_STARTUP_ERROR_LOG%"
  set "MEMORY_SUITE_BOOTSTRAP_ERROR=DATA\config\server-config.json을 읽거나 검증하지 못했습니다."
  set "MEMORY_SUITE_BOOTSTRAP_EXIT=14"
  goto :bootstrap_failed
)
call "%MEMORY_SUITE_ENV_FILE%"
set "MEMORY_SUITE_STEP_EXIT=%ERRORLEVEL%"
if exist "%MEMORY_SUITE_ENV_FILE%" del /q "%MEMORY_SUITE_ENV_FILE%" >nul 2>&1
if exist "%MEMORY_SUITE_CONFIG_ERR%" del /q "%MEMORY_SUITE_CONFIG_ERR%" >nul 2>&1
set "MEMORY_SUITE_ENV_FILE="
set "MEMORY_SUITE_CONFIG_ERR="
if not "%MEMORY_SUITE_STEP_EXIT%"=="0" (
  set "MEMORY_SUITE_BOOTSTRAP_ERROR=생성된 서버 설정 환경을 적용하지 못했습니다."
  set "MEMORY_SUITE_BOOTSTRAP_EXIT=15"
  goto :bootstrap_failed
)
if not defined MEMORY_SUITE_SERVER_URL (
  set "MEMORY_SUITE_BOOTSTRAP_ERROR=필수 서버 URL이 비어 있습니다."
  set "MEMORY_SUITE_BOOTSTRAP_EXIT=16"
  goto :bootstrap_failed
)
if not defined MEMORY_SUITE_HOST (
  set "MEMORY_SUITE_BOOTSTRAP_ERROR=필수 서버 HOST가 비어 있습니다."
  set "MEMORY_SUITE_BOOTSTRAP_EXIT=16"
  goto :bootstrap_failed
)
if not defined MEMORY_SUITE_PORT (
  set "MEMORY_SUITE_BOOTSTRAP_ERROR=필수 서버 PORT가 비어 있습니다."
  set "MEMORY_SUITE_BOOTSTRAP_EXIT=16"
  goto :bootstrap_failed
)
set "MEMORY_SUITE_AUTO_BACKUP_ARG="
if /i "%MEMORY_SUITE_AUTO_BACKUP%"=="false" set "MEMORY_SUITE_AUTO_BACKUP_ARG=--no-auto-backup"
echo [3/4] 서버 설정 준비 완료: %MEMORY_SUITE_SERVER_URL%

set "MEMORY_SUITE_BOOTSTRAP_STAGE=완료"
echo [4/4] 서버 실행 준비가 완료되었습니다.
>>"%MEMORY_SUITE_STARTUP_LOG%" echo [%DATE% %TIME%] bootstrap ready url=%MEMORY_SUITE_SERVER_URL%
set "MEMORY_SUITE_BOOTSTRAP_EXIT=0"
exit /b 0

:node_only_ready
rem Read-only commands and the unified launcher need Node.js only. They must not
rem prepare, migrate, configure, or write anything under DATA here.
echo [2/2] 공통 런처 준비 완료. DATA는 변경하지 않았습니다.
if exist "%MEMORY_SUITE_TEMP_STARTUP_LOG%" del /q "%MEMORY_SUITE_TEMP_STARTUP_LOG%" >nul 2>&1
set "MEMORY_SUITE_STARTUP_LOG="
set "MEMORY_SUITE_STARTUP_ERROR_LOG="
set "MEMORY_SUITE_BOOTSTRAP_STAGE=완료"
set "MEMORY_SUITE_BOOTSTRAP_EXIT=0"
exit /b 0

:bootstrap_failed
if not defined MEMORY_SUITE_BOOTSTRAP_ERROR set "MEMORY_SUITE_BOOTSTRAP_ERROR=알 수 없는 준비 오류가 발생했습니다."
if not defined MEMORY_SUITE_STARTUP_ERROR_LOG set "MEMORY_SUITE_STARTUP_ERROR_LOG=%MEMORY_SUITE_TEMP_STARTUP_LOG%"
>>"%MEMORY_SUITE_STARTUP_ERROR_LOG%" echo.
>>"%MEMORY_SUITE_STARTUP_ERROR_LOG%" echo [%DATE% %TIME%] bootstrap failed
>>"%MEMORY_SUITE_STARTUP_ERROR_LOG%" echo STAGE=%MEMORY_SUITE_BOOTSTRAP_STAGE%
>>"%MEMORY_SUITE_STARTUP_ERROR_LOG%" echo ERROR=%MEMORY_SUITE_BOOTSTRAP_ERROR%
>>"%MEMORY_SUITE_STARTUP_ERROR_LOG%" echo EXIT=%MEMORY_SUITE_BOOTSTRAP_EXIT%
if exist "%MEMORY_SUITE_INSTALL_LOG%" type "%MEMORY_SUITE_INSTALL_LOG%" >>"%MEMORY_SUITE_STARTUP_ERROR_LOG%"
if exist "%MEMORY_SUITE_PREPARE_OUT%" type "%MEMORY_SUITE_PREPARE_OUT%" >>"%MEMORY_SUITE_STARTUP_ERROR_LOG%"
if exist "%MEMORY_SUITE_PREPARE_ERR%" type "%MEMORY_SUITE_PREPARE_ERR%" >>"%MEMORY_SUITE_STARTUP_ERROR_LOG%"
if exist "%MEMORY_SUITE_CONFIG_ERR%" type "%MEMORY_SUITE_CONFIG_ERR%" >>"%MEMORY_SUITE_STARTUP_ERROR_LOG%"
if exist "%MEMORY_SUITE_ENV_FILE%" del /q "%MEMORY_SUITE_ENV_FILE%" >nul 2>&1
if exist "%MEMORY_SUITE_INSTALL_LOG%" del /q "%MEMORY_SUITE_INSTALL_LOG%" >nul 2>&1
if exist "%MEMORY_SUITE_PREPARE_OUT%" del /q "%MEMORY_SUITE_PREPARE_OUT%" >nul 2>&1
if exist "%MEMORY_SUITE_PREPARE_ERR%" del /q "%MEMORY_SUITE_PREPARE_ERR%" >nul 2>&1
if exist "%MEMORY_SUITE_CONFIG_ERR%" del /q "%MEMORY_SUITE_CONFIG_ERR%" >nul 2>&1
echo.
echo [Librarian System] 서버 준비에 실패했습니다.
echo 단계: %MEMORY_SUITE_BOOTSTRAP_STAGE%
echo 원인: %MEMORY_SUITE_BOOTSTRAP_ERROR%
echo 진단 로그: %MEMORY_SUITE_STARTUP_ERROR_LOG%
exit /b %MEMORY_SUITE_BOOTSTRAP_EXIT%
