@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions
title freeclaude - статус

rem =====================================================================
rem  freeclaude-status.bat - что происходит с OmniRoute и Claude Code
rem
rem  freeclaude-status                 показать статус
rem  freeclaude-status --open          показать статус и открыть дашборд
rem  freeclaude-status --autostart-on  включить автозапуск шлюза
rem  freeclaude-status --autostart-off выключить автозапуск шлюза
rem =====================================================================

set "OMNIROUTE_NO_UPDATE_NOTIFIER=1"
set "OR_ACTION=show"
set "OR_OPEN=0"
set "OR_HOME=%USERPROFILE%"
if not defined OR_HOME set "OR_HOME=%SystemDrive%\Users\Public"
set "OR_TMP=%TEMP%"
if not defined OR_TMP set "OR_TMP=%OR_HOME%"
if not defined OMNIROUTE_PORT set "OMNIROUTE_PORT=20128"
set "OR_PORT=%OMNIROUTE_PORT%"
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%USERPROFILE%\.local\bin;%LOCALAPPDATA%\Microsoft\WinGet\Links;%LOCALAPPDATA%\Microsoft\WindowsApps;%APPDATA%\npm;%PATH%"

if /i "%~1"=="--open" set "OR_OPEN=1"
if /i "%~1"=="--autostart-on" set "OR_ACTION=ast_on"
if /i "%~1"=="--autostart-off" set "OR_ACTION=ast_off"

echo.
echo  ============================================================
echo    freeclaude - статус
echo  ============================================================
echo   Версии:
for /f "delims=" %%v in ('node -v 2^>nul') do echo     Node.js:      %%v
where node >nul 2>&1
if errorlevel 1 echo     Node.js:      не установлен
for /f "delims=" %%v in ('omniroute --version 2^>nul') do echo     OmniRoute:    %%v
where omniroute >nul 2>&1
if errorlevel 1 echo     OmniRoute:    не установлен
for /f "delims=" %%c in ('claude --version 2^>nul') do echo     Claude Code:  %%c
where claude >nul 2>&1
if errorlevel 1 echo     Claude Code:  не установлен
echo.

echo   Автозапуск при входе в Windows:
if /i "%OR_ACTION%"=="ast_on" call :autostart_on
if /i "%OR_ACTION%"=="ast_off" call :autostart_off
set "OR_AST=unknown"
where omniroute >nul 2>&1
if errorlevel 1 goto :ast_show
call omniroute autostart status --output json > "%OR_TMP%\freeclaude_ast.json" 2>nul
node -e "var fs=require('fs');try{var t=fs.readFileSync(process.argv[1],'utf8');var i=t.indexOf('{');var j=JSON.parse(t.slice(i));process.stdout.write(j.enabled?'yes':'no')}catch(e){process.stdout.write('unknown')}" "%OR_TMP%\freeclaude_ast.json" > "%OR_TMP%\freeclaude_ast.txt" 2>nul
set /p OR_AST=<"%OR_TMP%\freeclaude_ast.txt"
:ast_show
if /i "%OR_AST%"=="yes" echo     Автозапуск:   включён
if /i "%OR_AST%"=="no" echo     Автозапуск:   выключен
if /i "%OR_AST%"=="unknown" echo     Автозапуск:   состояние неизвестно
echo     Переключить:  freeclaude-status --autostart-on ^| --autostart-off
echo.

echo   Шлюз OmniRoute:
call :probe_health
if errorlevel 1 goto :server_down
echo     Сервер:       запущен на порту %OR_PORT%
echo     Дашборд:      http://localhost:%OR_PORT%
echo     API:          http://localhost:%OR_PORT%/v1
call omniroute providers status --json > "%OR_TMP%\freeclaude_prov.json" 2>nul
node -e "var fs=require('fs');try{var t=fs.readFileSync(process.argv[1],'utf8');var i=t.indexOf('{');var j=JSON.parse(t.slice(i));var l=(j&&j.list)||[];fs.writeFileSync(process.argv[2],String(typeof j.count==='number'?j.count:l.length));var names=l.map(function(x){return x.provider||x.id||'?'});fs.writeFileSync(process.argv[3],names.length?names.join(', '):'нет')}catch(e){fs.writeFileSync(process.argv[2],'-1');fs.writeFileSync(process.argv[3],'неизвестно')}" "%OR_TMP%\freeclaude_prov.json" "%OR_TMP%\freeclaude_prov_n.txt" "%OR_TMP%\freeclaude_prov_names.txt"
set "OR_PN=?"
set /p OR_PN=<"%OR_TMP%\freeclaude_prov_n.txt"
set "OR_PNAMES=неизвестно"
set /p OR_PNAMES=<"%OR_TMP%\freeclaude_prov_names.txt"
if "%OR_PN%"=="0" echo     Провайдеры:   НЕ ПОДКЛЮЧЕНЫ - откройте дашборд и подключите Kiro AI
if "%OR_PN%"=="-1" echo     Провайдеры:   список получить не удалось
if "%OR_PN%"=="0" goto :prov_done
if "%OR_PN%"=="-1" goto :prov_done
echo     Провайдеры:   %OR_PN% - %OR_PNAMES%
:prov_done
echo.
call omniroute health 2>nul
if %OR_OPEN%==1 start "" "http://localhost:%OR_PORT%"
goto :done

:server_down
echo     Сервер:       не отвечает на http://127.0.0.1:%OR_PORT%
echo     Запустите его командой:  freeclaude --setup
echo     Логи и диагностика:      omniroute doctor
echo.

:done
echo  ------------------------------------------------------------
echo    Запуск Claude Code: freeclaude
echo    Остановить шлюз:    freeclaude-stop
echo  ============================================================
echo.
exit /b 0

:autostart_on
where omniroute >nul 2>&1
if errorlevel 1 exit /b 0
call omniroute autostart enable >nul 2>&1
if errorlevel 1 echo     Не удалось включить автозапуск.
exit /b 0

:autostart_off
where omniroute >nul 2>&1
if errorlevel 1 exit /b 0
call omniroute autostart disable >nul 2>&1
if errorlevel 1 echo     Не удалось выключить автозапуск.
exit /b 0

:probe_health
where node >nul 2>&1
if errorlevel 1 exit /b 1
node -e "fetch('http://127.0.0.1:'+process.env.OMNIROUTE_PORT+'/api/monitoring/health',{signal:AbortSignal.timeout(2000)}).then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})" >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0
