@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions
title freeclaude - обновление

rem =====================================================================
rem  freeclaude-update.bat - обновить OmniRoute и Claude Code
rem
rem  freeclaude-update             обновить всё
rem  freeclaude-update --no-pause  без ожидания нажатия клавиши
rem
rem  Настройки, ключи и подключённые провайдеры лежат в %USERPROFILE%\.omniroute
rem  и при обновлении не теряются.
rem =====================================================================

set "OMNIROUTE_NO_UPDATE_NOTIFIER=1"
set "OR_PAUSE=1"
set "OR_WAS_RUNNING=0"
set "OR_HOME=%USERPROFILE%"
if not defined OR_HOME set "OR_HOME=%SystemDrive%\Users\Public"
if not defined OMNIROUTE_PORT set "OMNIROUTE_PORT=20128"
set "OR_PORT=%OMNIROUTE_PORT%"
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%USERPROFILE%\.local\bin;%LOCALAPPDATA%\Microsoft\WinGet\Links;%LOCALAPPDATA%\Microsoft\WindowsApps;%APPDATA%\npm;%PATH%"

if /i "%~1"=="--no-pause" set "OR_PAUSE=0"

echo.
echo  ============================================================
echo    freeclaude - обновление
echo  ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 goto :no_node

call :probe_health
if not errorlevel 1 set "OR_WAS_RUNNING=1"

echo   Обновляю OmniRoute...
call npm install -g omniroute@latest --no-fund --no-audit
if not errorlevel 1 goto :omni_ok
echo   [ВНИМАНИЕ] npm вернул ошибку. OmniRoute мог не обновиться.
goto :restart
:omni_ok
echo   OmniRoute обновлён.

:restart
if "%OR_WAS_RUNNING%"=="0" goto :claude
echo.
echo   Перезапускаю шлюз с новой версией...
call omniroute stop >nul 2>&1
if not defined OMNIROUTE_SERVER_HOST set "OMNIROUTE_SERVER_HOST=127.0.0.1"
call omniroute serve --daemon --no-open --port %OR_PORT%
goto :claude

:claude
echo.
echo   Проверяю Claude Code...
where claude >nul 2>&1
if errorlevel 1 goto :claude_skip
if exist "%USERPROFILE%\.local\bin\claude.exe" goto :claude_winget
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps\claude.exe" goto :claude_winget
if exist "%APPDATA%\npm\claude.cmd" goto :claude_npm
echo   Обновление Claude Code выполните вручную:  claude update
goto :versions

:claude_winget
where winget >nul 2>&1
if errorlevel 1 goto :claude_npm
winget upgrade --id Anthropic.ClaudeCode -e --accept-source-agreements --accept-package-agreements --silent >nul 2>&1
if not errorlevel 1 echo   Claude Code обновлён через winget.
if errorlevel 1 echo   Обновлений Claude Code через winget нет. При необходимости: claude update
goto :versions

:claude_npm
call npm install -g @anthropic-ai/claude-code@latest --no-fund --no-audit
if not errorlevel 1 echo   Claude Code обновлён через npm.
if errorlevel 1 echo   [ВНИМАНИЕ] Обновить Claude Code не удалось.
goto :versions

:claude_skip
echo   Claude Code не установлен. Поставить:  freeclaude --setup

:versions
echo.
echo  ------------------------------------------------------------
echo   Итоговые версии:
for /f "delims=" %%v in ('node -v 2^>nul') do echo     Node.js:      %%v
for /f "delims=" %%v in ('omniroute --version 2^>nul') do echo     OmniRoute:    %%v
for /f "delims=" %%c in ('claude --version 2^>nul') do echo     Claude Code:  %%c
echo  ------------------------------------------------------------
echo.
echo   Запуск:  freeclaude
echo.
if "%OR_PAUSE%"=="0" exit /b 0
echo   Нажмите любую клавишу, чтобы закрыть окно...
pause >nul
exit /b 0

:no_node
echo   [ОШИБКА] Node.js не найден, обновлять нечем.
echo   Запустите:  freeclaude --setup
echo.
if "%OR_PAUSE%"=="0" exit /b 1
echo   Нажмите любую клавишу, чтобы закрыть окно...
pause >nul
exit /b 1

:probe_health
node -e "fetch('http://127.0.0.1:'+process.env.OMNIROUTE_PORT+'/api/monitoring/health',{signal:AbortSignal.timeout(2000)}).then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})" >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0
