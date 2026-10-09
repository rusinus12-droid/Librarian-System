@echo off
chcp 65001 >nul
setlocal
title Librarian System Builder
set "MEMORY_SUITE_NODE_ONLY=1"
call "%~dp0_common.cmd"
if errorlevel 1 ( pause & exit /b 2 )
if "%~1"=="" (
  "%NODE_EXE%" --no-warnings "%~dp0tools\release_builder_ui.cjs" --profile all
) else (
  "%NODE_EXE%" --no-warnings "%~dp0tools\build_distribution.cjs" --profile all %*
)
set "ERR=%ERRORLEVEL%"
echo.
if "%ERR%"=="0" (echo [Librarian System] 빌드 완료) else (echo [Librarian System] 빌드 실패)
pause
exit /b %ERR%
