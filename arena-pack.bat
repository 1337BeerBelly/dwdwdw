@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions
title arena-pack - отправить проект в чат

rem =====================================================================
rem  arena-pack.bat - упаковать папку проекта в zip для отправки в чат.
rem
rem  Как запускать:
rem    - перетащите папку проекта на этот файл; или
rem    - запустите двойным щелчком и вставьте путь; или
rem    - из терминала:  arena-pack C:\dev\my-app --include src
rem
rem  Параметры: --include, --exclude, --max, --all, --with-secrets,
rem             --out, --request, --dry-run, --clip, --yes, --no-prompt
rem             (подробно: arena-pack.bat --help)
rem =====================================================================

set "OR_ARGS=%*"
set "ARENA_PAUSE=0"

rem --- окно закрывается только при запуске двойным щелчком --------------
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul 2>&1 && set "ARENA_PAUSE=1"

where node >nul 2>&1
if errorlevel 1 goto :no_node

node "%~dp0tools\arena-pack.mjs" %OR_ARGS%
set "OR_CODE=%ERRORLEVEL%"
goto :finish

:no_node
echo.
echo   [ОШИБКА] Не найден Node.js - без него инструменты обмена не работают.
echo   1. Установите Node.js:  winget install --id OpenJS.NodeJS.LTS -e
echo   2. Или запустите freeclaude --setup - он поставит Node.js сам.
echo   3. Закройте это окно и попробуйте снова.
echo.
set "OR_CODE=1"

:finish
exit /b %OR_CODE%
