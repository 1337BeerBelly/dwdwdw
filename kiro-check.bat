@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions
title kiro-check - доступность сервисов Kiro

rem =====================================================================
rem  kiro-check.bat - почему не открывается портал Kiro / не подключается
rem                  провайдер: проверка доменов, шлюза, прокси и часов.
rem
rem  Как запускать:
rem    - двойной щелчок; или
rem    - из терминала:  kiro-check
rem    - для отправки в чат:  kiro-check --json > kiro-check.json
rem
rem  Параметры: --json, --port <порт>, --timeout <мс>, --no-pause
rem =====================================================================

set "OR_ARGS=%*"
set "ARENA_PAUSE=0"

echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul 2>&1 && set "ARENA_PAUSE=1"

where node >nul 2>&1
if errorlevel 1 goto :no_node

node "%~dp0tools\kiro-check.mjs" %OR_ARGS%
set "OR_CODE=%ERRORLEVEL%"
goto :finish

:no_node
echo.
echo   [ОШИБКА] Не найден Node.js - без него проверка не работает.
echo   1. Установите Node.js:  winget install --id OpenJS.NodeJS.LTS -e
echo   2. Или запустите freeclaude --setup - он поставит Node.js сам.
echo.
set "OR_CODE=1"

:finish
exit /b %OR_CODE%
