@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions
title freeclaude - установка комплекта

rem =====================================================================
rem  install.bat - одноразовая установка комплекта freeclaude
rem
rem  Что делает:
rem    1. Копирует скрипты в C:\bat
rem    2. Добавляет C:\bat в PATH пользователя
rem    3. Ставит Node.js, OmniRoute и Claude Code (если их нет)
rem    4. Поднимает локальный шлюз OmniRoute
rem    5. Включает автозапуск OmniRoute при входе в Windows
rem
rem  После установки в любом терминале работает команда:  freeclaude
rem =====================================================================

set "OMNIROUTE_NO_UPDATE_NOTIFIER=1"
set "OR_SRC=%~dp0"
if "%OR_SRC:~-1%"=="\" set "OR_SRC=%OR_SRC:~0,-1%"
set "OR_DST=C:\bat"
set "OR_HOME=%USERPROFILE%"
if not defined OR_HOME set "OR_HOME=%SystemDrive%\Users\Public"
set "OR_TMP=%TEMP%"
if not defined OR_TMP set "OR_TMP=%OR_HOME%"
if not defined OMNIROUTE_PORT set "OMNIROUTE_PORT=20128"
set "OR_PORT=%OMNIROUTE_PORT%"

echo.
echo  ============================================================
echo    freeclaude - установка
echo  ============================================================
echo   Откуда: %OR_SRC%
echo   Куда:   %OR_DST%
echo.

rem ------------------------- 1. копирование -------------------------
if /i "%OR_SRC%"=="%OR_DST%" goto :skipped_copy
if not exist "%OR_DST%\" mkdir "%OR_DST%" >nul 2>&1
if not exist "%OR_DST%\" goto :copy_failed

echo   Копирую скрипты в %OR_DST%...
copy /y "%OR_SRC%\freeclaude.bat" "%OR_DST%\" >nul
copy /y "%OR_SRC%\install.bat" "%OR_DST%\" >nul
if exist "%OR_SRC%\freeclaude-stop.bat" copy /y "%OR_SRC%\freeclaude-stop.bat" "%OR_DST%\" >nul
if exist "%OR_SRC%\freeclaude-status.bat" copy /y "%OR_SRC%\freeclaude-status.bat" "%OR_DST%\" >nul
if exist "%OR_SRC%\freeclaude-update.bat" copy /y "%OR_SRC%\freeclaude-update.bat" "%OR_DST%\" >nul
if exist "%OR_SRC%\README.md" copy /y "%OR_SRC%\README.md" "%OR_DST%\" >nul
if exist "%OR_SRC%\docs\TROUBLESHOOTING.md" mkdir "%OR_DST%\docs" >nul 2>&1
if exist "%OR_SRC%\docs\TROUBLESHOOTING.md" copy /y "%OR_SRC%\docs\TROUBLESHOOTING.md" "%OR_DST%\docs\" >nul
goto :copied

:copy_failed
echo   [ВНИМАНИЕ] Не удалось создать %OR_DST%. Работаю из текущей папки.
set "OR_DST=%OR_SRC%"
goto :copied

:skipped_copy
echo   Скрипты уже лежат в %OR_DST% - копирование не нужно.

:copied
set "PATH=%OR_DST%;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%USERPROFILE%\.local\bin;%LOCALAPPDATA%\Microsoft\WinGet\Links;%LOCALAPPDATA%\Microsoft\WindowsApps;%APPDATA%\npm;%PATH%"

rem ------------------------- 2. PATH -------------------------
echo   Добавляю %OR_DST% в PATH пользователя...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d='%OR_DST%';$p=[Environment]::GetEnvironmentVariable('Path','User');if($null -eq $p){$p=''};$u=$p.TrimEnd(';');if($u -eq ''){$n=$d}elseif($u.Split(';') -notcontains $d){$n=$u+';'+$d}else{$n=$u};[Environment]::SetEnvironmentVariable('Path',$n,'User')"
echo   Готово. В новых окнах терминала доступна команда freeclaude.

rem ------------------------- 3. настройки шлюза -------------------------
if defined DATA_DIR goto :after_env
set "OR_ENV=%OR_HOME%\.omniroute\.env"
if not exist "%OR_HOME%\.omniroute" mkdir "%OR_HOME%\.omniroute" >nul 2>&1
findstr /b /c:"OMNIROUTE_SERVER_HOST=" "%OR_ENV%" >nul 2>&1
if not errorlevel 1 goto :after_env
echo OMNIROUTE_SERVER_HOST=127.0.0.1>>"%OR_ENV%"
echo   В %OR_ENV% добавлена строка OMNIROUTE_SERVER_HOST=127.0.0.1
echo   Шлюз будет слушать только localhost. Нужен доступ по сети - строку уберите.
:after_env

rem ------------------------- 4. компоненты и сервер -------------------------
call "%OR_DST%\freeclaude.bat" --setup --no-pause
if errorlevel 1 goto :setup_failed

rem ------------------------- 5. автозапуск -------------------------
echo   Включаю автозапуск OmniRoute при входе в Windows...
where omniroute >nul 2>&1
if errorlevel 1 goto :autostart_skipped
call omniroute autostart enable >nul 2>&1
if errorlevel 1 goto :autostart_skipped
echo   Автозапуск включён. Отключить: freeclaude-stop --autostart-off
goto :done

:autostart_skipped
echo   Автозапуск включить не удалось, это не критично. Позже: omniroute autostart enable

:done
echo.
echo  ============================================================
echo    Установка завершена
echo  ------------------------------------------------------------
echo    Откройте НОВОЕ окно терминала, перейдите в папку проекта
echo    и выполните:   freeclaude
echo.
echo    Дашборд OmniRoute:  http://localhost:%OR_PORT%
echo    Статус:             freeclaude-status
echo    Остановить шлюз:    freeclaude-stop
echo    Обновить:           freeclaude-update
echo  ============================================================
echo.
echo   Нажмите любую клавишу, чтобы закрыть окно...
pause >nul
exit /b 0

:setup_failed
echo.
echo   [ОШИБКА] Установка компонентов не завершилась. Смотрите сообщение выше.
echo   Подсказки по типовым ошибкам: docs\TROUBLESHOOTING.md
echo.
echo   Нажмите любую клавишу, чтобы закрыть окно...
pause >nul
exit /b 1
