@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
call "%~dp0..\_common.cmd"
if errorlevel 1 (
  pause
  exit /b 1
)
set "FAILED=0"
"%NODE_EXE%" --no-warnings --check "%~dp0..\server\server.cjs" || set "FAILED=1"
"%NODE_EXE%" --no-warnings --check "%~dp0..\server\admin.cjs" || set "FAILED=1"
"%NODE_EXE%" --no-warnings --check "%~dp0..\tools\prepare_data.cjs" || set "FAILED=1"
"%NODE_EXE%" --no-warnings --check "%~dp0..\tools\config_env.cjs" || set "FAILED=1"
"%NODE_EXE%" --no-warnings --check "%~dp0..\tools\check_node.cjs" || set "FAILED=1"
"%NODE_EXE%" --no-warnings --check "%~dp0..\tools\update_manifest.cjs" || set "FAILED=1"
"%NODE_EXE%" --no-warnings --check "%~dp0..\tools\sync_embedded_sdk.cjs" || set "FAILED=1"
"%NODE_EXE%" --no-warnings --check "%~dp0..\sdk\MemorySuiteStorageClient.source.js" || set "FAILED=1"
"%NODE_EXE%" --no-warnings --check "%~dp0..\sdk\MemorySuiteStorageClient.libra.source.js" || set "FAILED=1"
for %%F in ("%~dp0..\plugins\*.js") do "%NODE_EXE%" --no-warnings --check "%%~fF" || set "FAILED=1"
"%NODE_EXE%" --no-warnings "%~dp0..\tools\check_sdk_sync.cjs" || set "FAILED=1"
for %%T in ("%~dp0..\tests\*.cjs") do "%NODE_EXE%" --no-warnings "%%~fT" || set "FAILED=1"
echo.
if "%FAILED%"=="0" echo 모든 시험을 통과했습니다.
if not "%FAILED%"=="0" echo 일부 시험에 실패했습니다.
pause
exit /b %FAILED%
