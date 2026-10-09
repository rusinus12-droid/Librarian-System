@echo off
chcp 65001 >nul
setlocal
for %%I in ("%~dp0..") do set "MEMORY_SUITE_ROOT_DIR=%%~fI"
set "MEMORY_SUITE_DATA_DIR=%MEMORY_SUITE_ROOT_DIR%\DATA"
if not exist "%MEMORY_SUITE_DATA_DIR%" mkdir "%MEMORY_SUITE_DATA_DIR%"
start "" explorer.exe "%MEMORY_SUITE_DATA_DIR%"
