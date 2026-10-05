@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions
title freeclaude - остановка OmniRoute

rem =====================================================================
rem  freeclaude-stop.bat - остановить локальный шлюз OmniRoute
rem
rem  freeclaude-stop                  остановить сервер
rem  freeclaude-stop --autostart-off  остановить сервер и выключить автозапуск
rem  freeclaude-stop --autostart-on   остановить сервер и включить автозапуск
rem  freeclaude-stop --no-pause       без ожидания нажатия клавиши
rem =====================================================================

set "OMNIROUTE_NO_UPDATE_NOTIFIER=1"
set "OR_AST=noop"
set "OR_PAUSE=1"
set "OR_HOME=%USERPROFILE%"
if not defined OR_HOME set "OR_HOME=%SystemDrive%\Users\Public"
if not defined OMNIROUTE_PORT set "OMNIROUTE_PORT=20128"
set "OR_PORT=%OMNIROUTE_PORT%"
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%USERPROFILE%\.local\bin;%LOCALAPPDATA%\Microsoft\WinGet\Links;%LOCALAPPDATA%\Microsoft\WindowsApps;%APPDATA%\npm;%PATH%"

if /i "%~1"=="--autostart-off" set "OR_AST=off"
if /i "%~1"=="--autostart-on" set "OR_AST=on"
if /i "%~1"=="--no-pause" set "OR_PAUSE=0"

echo.
echo  ============================================================
echo    freeclaude - остановка OmniRoute
echo  ============================================================
echo.

where omniroute >nul 2>&1
if errorlevel 1 goto :no_omniroute

call :probe_health
if errorlevel 1 goto :already_down

echo   Останавливаю сервер на порту %OR_PORT%...
call omniroute stop
call :probe_health
if not errorlevel 1 goto :stop_failed
echo   Сервер остановлен.
goto :autostart

:already_down
echo   Сервер и так не запущен.
goto :autostart

:stop_failed
echo.
echo   [ВНИМАНИЕ] Сервер всё ещё отвечает на порту %OR_PORT%.
echo   Попробуйте ещё раз:  omniroute stop
echo   Если не помогает, завершите процесс node.exe, слушающий порт:
echo     netstat -ano ^| findstr :%OR_PORT%

:autostart
echo.
if /i "%OR_AST%"=="off" goto :ast_off
if /i "%OR_AST%"=="on" goto :ast_on
echo   Автозапуск не менялся. Состояние: freeclaude-status
echo   Выключить автозапуск:  freeclaude-stop --autostart-off
goto :finish

:ast_off
call omniroute autostart disable >nul 2>&1
if not errorlevel 1 goto :ast_off_ok
echo   Не удалось выключить автозапуск. Вручную: omniroute autostart disable
goto :finish
:ast_off_ok
echo   Автозапуск выключен - OmniRoute не будет стартовать сам при входе в Windows.
goto :finish

:ast_on
call omniroute autostart enable >nul 2>&1
if not errorlevel 1 goto :ast_on_ok
echo   Не удалось включить автозапуск. Вручную: omniroute autostart enable
goto :finish
:ast_on_ok
echo   Автозапуск включён - OmniRoute будет стартовать сам при входе в Windows.
goto :finish

:no_omniroute
echo   OmniRoute не установлен - останавливать нечего.

:finish
echo.
if "%OR_PAUSE%"=="0" exit /b 0
echo   Нажмите любую клавишу, чтобы закрыть окно...
pause >nul
exit /b 0

:probe_health
where node >nul 2>&1
if errorlevel 1 exit /b 1
node -e "fetch('http://127.0.0.1:'+process.env.OMNIROUTE_PORT+'/api/monitoring/health',{signal:AbortSignal.timeout(2000)}).then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})" >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0
