@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions
title arena-unpack - разложить правки из архива

rem =====================================================================
rem  arena-unpack.bat - разложить присланный из чата архив обратно в проект.
rem
rem  Как запускать:
rem    - перетащите zip-архив на этот файл; или
rem    - запустите двойным щелчком и вставьте путь к архиву; или
rem    - из терминала:  arena-unpack reply.zip --into C:\dev\my-app
rem
rem  Бэкап затронутых файлов: <проект>\_arena_backup\<пакет>\
rem  Параметры: --into, --here, --dry-run, --force, --no-pause
rem             (подробно: arena-unpack.bat --help)
rem =====================================================================

set "OR_ARGS=%*"
set "ARENA_PAUSE=0"

rem --- окно закрывается только при запуске двойным щелчком --------------
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul 2>&1 && set "ARENA_PAUSE=1"

where node >nul 2>&1
if errorlevel 1 goto :no_node

node "%~dp0tools\arena-unpack.mjs" %OR_ARGS%
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
