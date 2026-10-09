@echo off
set "NODE_EXE="
set "NODE_SOURCE="
set "NODE_CANDIDATE="
set "NODE_CANDIDATE_SOURCE="
set "NODE_CHECK_CODE="
set "MEMORY_SUITE_NODE_ERROR=node_not_found"

if exist "%~dp0_runtime\node.exe" (
  set "NODE_CANDIDATE=%~dp0_runtime\node.exe"
  set "NODE_CANDIDATE_SOURCE=portable"
  call :check_candidate
  if not errorlevel 1 exit /b 0
)

for %%N in (node.exe) do set "NODE_CANDIDATE=%%~$PATH:N"
if defined NODE_CANDIDATE (
  set "NODE_CANDIDATE_SOURCE=system_path"
  call :check_candidate
  if not errorlevel 1 exit /b 0
)

set "NODE_EXE="
set "NODE_SOURCE="
exit /b 1

:check_candidate
if not defined NODE_CANDIDATE exit /b 1
if not exist "%NODE_CANDIDATE%" exit /b 1
"%NODE_CANDIDATE%" --no-warnings "%~dp0tools\check_node.cjs" >nul 2>&1
set "NODE_CHECK_CODE=%ERRORLEVEL%"
if not "%NODE_CHECK_CODE%"=="0" (
  set "MEMORY_SUITE_NODE_ERROR=node_unusable_or_older_than_22_13:%NODE_CANDIDATE%:exit_%NODE_CHECK_CODE%"
  exit /b %NODE_CHECK_CODE%
)
for %%I in ("%NODE_CANDIDATE%") do set "NODE_EXE=%%~fI"
set "NODE_SOURCE=%NODE_CANDIDATE_SOURCE%"
set "MEMORY_SUITE_NODE_ERROR="
exit /b 0
