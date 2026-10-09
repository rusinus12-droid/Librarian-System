@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
echo PROGRAM 폴더 안에 Node.js 22 포터블 런타임을 설치합니다.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\tools\install_runtime.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" goto :done
call "%~dp0..\_find_node.bat"
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" echo 설치 및 실행 확인 완료: %NODE_EXE%
if not "%EXIT_CODE%"=="0" echo 설치 파일은 만들어졌지만 Node.js 실행 확인에 실패했습니다.
:done
pause
exit /b %EXIT_CODE%
