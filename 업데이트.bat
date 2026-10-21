@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
cd /d "%~dp0"

if not "%~1"=="" goto :ADVANCED

:MENU
cls
echo ========================================
echo       Librarian System 업데이트
echo ========================================
echo.
echo  1. 이 폴더의 서버를 최신 버전으로 업데이트
echo  2. 다른 기존 설치 폴더를 업데이트
echo     ^(0.3.51에서 처음 업데이트할 때도 이 메뉴 사용^)
echo  3. 미완료 업데이트 복구
echo  4. 내려받은 업데이트 ZIP을 직접 선택해서 업데이트 ^(인터넷 불필요^)
echo  0. 종료
echo.
set "MENU="
set /p "MENU=번호를 선택하세요: "
if "%MENU%"=="1" goto :CURRENT_UPDATE
if "%MENU%"=="2" goto :OTHER_UPDATE
if "%MENU%"=="3" goto :RECOVER
if "%MENU%"=="4" goto :LOCAL_UPDATE
if "%MENU%"=="0" exit /b 0
echo.
echo 잘못된 선택입니다.
pause
goto :MENU

:CURRENT_UPDATE
call "%~dp0UPDATER\_find_node.bat"
if errorlevel 1 goto :NODE_ERROR
"%NODE_EXE%" --no-warnings "%~dp0UPDATER\updater.cjs" --user-update
set "ERR=%ERRORLEVEL%"
goto :USER_DONE

:OTHER_UPDATE
echo.
echo 기존에 사용 중인 Librarian System 폴더를 입력하세요.
echo 폴더를 이 창으로 끌어다 놓아도 됩니다.
set "TARGET_ROOT="
set /p "TARGET_ROOT=기존 설치 폴더: "
if not defined TARGET_ROOT (
  echo.
  echo 폴더를 입력하지 않아 메뉴로 돌아갑니다.
  pause
  goto :MENU
)
set "TARGET_ROOT=%TARGET_ROOT:"=%"
if not exist "%TARGET_ROOT%\PROGRAM\VERSION.txt" (
  echo.
  echo [오류] Librarian System 설치 폴더를 확인할 수 없습니다.
  echo PROGRAM\VERSION.txt가 있는 최상위 폴더를 선택해 주세요.
  pause
  goto :MENU
)
if not exist "%TARGET_ROOT%\DATA\" (
  echo.
  echo [오류] 선택한 폴더에 DATA 폴더가 없습니다.
  pause
  goto :MENU
)
call "%~dp0UPDATER\_find_node.bat" --target-root "%TARGET_ROOT%"
if errorlevel 1 goto :NODE_ERROR
"%NODE_EXE%" --no-warnings "%~dp0UPDATER\updater.cjs" --user-update --target-root "%TARGET_ROOT%" --install-updater
set "ERR=%ERRORLEVEL%"
goto :USER_DONE

:RECOVER
call "%~dp0UPDATER\_find_node.bat"
if errorlevel 1 goto :NODE_ERROR
"%NODE_EXE%" --no-warnings "%~dp0UPDATER\updater.cjs" --recover
set "ERR=%ERRORLEVEL%"
goto :USER_DONE

:LOCAL_UPDATE
echo.
echo 파일 선택 창에서 내려받은 Librarian-System-버전.zip 을 선택하세요.
call "%~dp0UPDATER\_find_node.bat"
if errorlevel 1 goto :NODE_ERROR
"%NODE_EXE%" --no-warnings "%~dp0UPDATER\updater.cjs" --local-update
set "ERR=%ERRORLEVEL%"
goto :USER_DONE

:NODE_ERROR
echo.
echo [오류] 업데이트 실행에 필요한 Node.js 런타임을 찾지 못했습니다.
echo 기존 설치 폴더에 포함된 portable Node 또는 Node.js 22.13 이상이 필요합니다.
set "ERR=22"
goto :USER_DONE

:USER_DONE
echo.
if "%ERR%"=="0" (
  echo 작업이 끝났습니다.
) else (
  echo 작업을 완료하지 못했습니다.
  echo 자세한 내용: UPDATER\logs\latest.log
)
echo.
pause
exit /b %ERR%

:ADVANCED
call "%~dp0UPDATER\_find_node.bat" %*
if errorlevel 1 (
  echo [Librarian Updater] Node.js 22.13 or newer with node:sqlite is required.
  exit /b 22
)
"%NODE_EXE%" --no-warnings "%~dp0UPDATER\updater.cjs" %*
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" echo [Librarian Updater] See UPDATER\logs\latest.log for details.
exit /b %ERR%
