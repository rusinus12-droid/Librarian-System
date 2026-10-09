@echo off
set "NODE_EXE="
set "NODE_CANDIDATE="
set "UPDATER_TARGET_ROOT="
set "UPDATER_STAGE_ROOT=%~dp0.."
set "MEMORY_SUITE_NODE_ERROR=node_22_13_sqlite_not_found"
call :parse_args %*
for %%N in ("%~dp0_runtime\node.exe" "%~dp0_runtime\node-*.exe" "%~dp0..\PROGRAM\_runtime\node.exe") do (
  set "NODE_CANDIDATE=%%~fN"
  call :check_candidate
  if defined NODE_EXE exit /b 0
)
for /d %%D in ("%~dp0..\.rollback\*") do (
  set "NODE_CANDIDATE=%%~fD\PROGRAM\_runtime\node.exe"
  call :check_candidate
  if defined NODE_EXE exit /b 0
)
if defined UPDATER_TARGET_ROOT (
  for %%N in ("%UPDATER_TARGET_ROOT%\UPDATER\_runtime\node.exe" "%UPDATER_TARGET_ROOT%\UPDATER\_runtime\node-*.exe" "%UPDATER_TARGET_ROOT%\PROGRAM\_runtime\node.exe") do (
    set "NODE_CANDIDATE=%%~fN"
    call :check_candidate
    if defined NODE_EXE exit /b 0
  )
  for /d %%D in ("%UPDATER_TARGET_ROOT%\.rollback\*") do (
    set "NODE_CANDIDATE=%%~fD\PROGRAM\_runtime\node.exe"
    call :check_candidate
    if defined NODE_EXE exit /b 0
  )
)
for %%N in (node.exe) do set "NODE_CANDIDATE=%%~$PATH:N"
call :check_candidate
if defined NODE_EXE exit /b 0
exit /b 22

:parse_args
if "%~1"=="" exit /b 0
if /I "%~1"=="--target-root" (
  if "%~2"=="" exit /b 0
  set "UPDATER_TARGET_ROOT=%~f2"
  set "UPDATER_STAGE_ROOT=%~f2"
  shift
  shift
  goto :parse_args
)
shift
goto :parse_args

:check_candidate
if not defined NODE_CANDIDATE exit /b 1
if not exist "%NODE_CANDIDATE%" exit /b 1
"%NODE_CANDIDATE%" --no-warnings "%~dp0runtime.cjs" --check >nul 2>&1
if errorlevel 1 exit /b 1
for /f "delims=" %%I in ('""%NODE_CANDIDATE%" --no-warnings "%~dp0runtime.cjs" --stage-runtime "%UPDATER_STAGE_ROOT%""') do set "NODE_EXE=%%I"
if not defined NODE_EXE exit /b 1
set "MEMORY_SUITE_NODE_ERROR="
exit /b 0
