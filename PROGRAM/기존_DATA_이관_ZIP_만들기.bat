@echo off
setlocal
call "%~dp0_find_node.bat"
if errorlevel 1 exit /b 1
set /p OLD_DATA=기존 DATA 폴더 전체 경로: 
set /p OUT_ZIP=저장할 이관 ZIP 전체 경로: 
"%NODE_EXE%" --experimental-sqlite "%~dp0tools\portable_export_stopped.cjs" --source-data-dir "%OLD_DATA%" --output "%OUT_ZIP%"
echo.
pause
