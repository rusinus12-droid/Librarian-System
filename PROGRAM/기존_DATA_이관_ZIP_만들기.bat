@echo off
chcp 65001 >nul
setlocal
call "%~dp0_find_node.bat"
if errorlevel 1 (
  echo [Librarian System] Node.js 22.13 이상을 찾지 못했습니다.
  echo 관리도구\포터블_Node_런타임_설치.bat 로 portable Node를 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)
set "OLD_DATA="
set "OUT_ZIP="
set /p "OLD_DATA=기존 DATA 폴더 전체 경로: "
if not defined OLD_DATA goto :NO_INPUT
rem 탐색기에서 끌어다 놓으면 붙는 따옴표를 제거합니다.
set "OLD_DATA=%OLD_DATA:"=%"
set /p "OUT_ZIP=저장할 이관 ZIP 전체 경로: "
if not defined OUT_ZIP goto :NO_INPUT
set "OUT_ZIP=%OUT_ZIP:"=%"
"%NODE_EXE%" --experimental-sqlite "%~dp0tools\portable_export_stopped.cjs" --source-data-dir "%OLD_DATA%" --output "%OUT_ZIP%"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXIT_CODE%

:NO_INPUT
echo 경로를 입력하지 않아 종료합니다.
pause
exit /b 2
