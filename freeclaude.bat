@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions
title freeclaude - Claude Code via OmniRoute

rem =====================================================================
rem  freeclaude.bat - запуск Claude Code через OmniRoute
rem  Описание, установка и решение проблем: см. README.md
rem
rem  Использование:
rem    freeclaude                   запустить Claude Code через OmniRoute
rem    freeclaude --setup           только проверить/доустановить и поднять сервер
rem    freeclaude --dir C:\project  запустить Claude Code в папке проекта
rem    freeclaude --version         показать версии компонентов
rem    freeclaude --help            эта справка
rem
rem  Все остальные аргументы передаются в Claude Code без изменений:
rem    freeclaude -p "вопрос"       freeclaude --continue
rem =====================================================================

set "OMNIROUTE_NO_UPDATE_NOTIFIER=1"
set "OR_MODE=run"
set "OR_ARGS="
set "OR_PROJECT="
set "OR_KEY="
set "OR_PROV="
set "OR_HOME=%USERPROFILE%"
if not defined OR_HOME set "OR_HOME=%SystemDrive%\Users\Public"
set "OR_TMP=%TEMP%"
if not defined OR_TMP set "OR_TMP=%OR_HOME%"
if not defined OMNIROUTE_PORT set "OMNIROUTE_PORT=20128"
set "OR_PORT=%OMNIROUTE_PORT%"

rem ------------------------- разбор аргументов -------------------------
:parse
if "%~1"=="" goto :parsed
if /i "%~1"=="--setup" goto :arg_setup
if /i "%~1"=="setup" goto :arg_setup
if /i "%~1"=="--no-pause" goto :arg_nopause
if /i "%~1"=="--dir" goto :arg_dir
if /i "%~1"=="--version" goto :arg_version
if /i "%~1"=="-v" goto :arg_version
if /i "%~1"=="version" goto :arg_version
if /i "%~1"=="--help" goto :arg_help
if /i "%~1"=="-h" goto :arg_help
if /i "%~1"=="help" goto :arg_help
if /i "%~1"=="/?" goto :arg_help
goto :arg_plain

:arg_setup
set "OR_MODE=setup"
goto :arg_next

:arg_nopause
set "OR_NOPAUSE=1"
goto :arg_next

:arg_dir
if not "%~2"=="" set "OR_PROJECT=%~2"
shift
goto :arg_next

:arg_version
set "OR_MODE=version"
goto :arg_next

:arg_help
set "OR_MODE=help"
goto :arg_next

:arg_plain
set "OR_ARGS=%OR_ARGS% "%~1""

:arg_next
shift
goto :parse

:parsed
if /i "%OR_MODE%"=="help" goto :show_help
if /i "%OR_MODE%"=="version" goto :show_version

echo.
echo  ============================================================
echo    freeclaude - Claude Code через OmniRoute
echo  ============================================================
echo.

if not "%OR_PROJECT%"=="" goto :chdir_project
goto :step_node

:chdir_project
if not exist "%OR_PROJECT%\" goto :bad_project
cd /d "%OR_PROJECT%"
echo   Рабочая папка: %CD%
echo.
goto :step_node

:bad_project
echo   [ОШИБКА] Папка не найдена: %OR_PROJECT%
echo   Проверьте путь и запустите снова, например:
echo     freeclaude --dir "C:\Users\%USERNAME%\projects\my-app"
goto :fatal

rem ------------------------- 1. Node.js -------------------------
:step_node
call :ensure_node
if errorlevel 1 goto :fatal

rem ------------------------- 2. OmniRoute -------------------------
call :ensure_omniroute
if errorlevel 1 goto :fatal

rem ------------------------- 3. Claude Code -------------------------
call :ensure_claude
if errorlevel 1 goto :fatal

rem ------------------------- 4. сервер -------------------------
call :ensure_server
if errorlevel 1 goto :fatal

rem ------------------------- 5. провайдер -------------------------
call :check_provider

rem ------------------------- 6. необязательный ключ -------------------------
call :load_api_key

rem ------------------------- 7. запуск -------------------------
if /i "%OR_MODE%"=="setup" goto :setup_done

echo   Запускаю Claude Code...
echo.
if defined OR_KEY goto :launch_with_key
call omniroute launch --port %OR_PORT% %OR_ARGS%
goto :after_launch

:launch_with_key
call omniroute launch --port %OR_PORT% --api-key %OR_KEY% %OR_ARGS%

:after_launch
set "OR_CODE=%ERRORLEVEL%"
if not "%OR_CODE%"=="0" goto :launch_failed
echo.
echo   Claude Code завершён. OmniRoute продолжает работать в фоне.
echo   Остановить сервер: freeclaude-stop
exit /b 0

:launch_failed
echo.
echo   Claude Code завершился с кодом %OR_CODE%.
echo   Если это ошибка запуска, проверьте: omniroute doctor
echo   Диагностика связки: freeclaude-status
exit /b %OR_CODE%

:setup_done
echo.
echo  ============================================================
echo    Готово. Все компоненты на месте, сервер работает.
echo  ------------------------------------------------------------
echo    Дашборд:      http://localhost:%OR_PORT%
echo    API:          http://localhost:%OR_PORT%/v1
echo    Провайдеры:   http://localhost:%OR_PORT%/dashboard/providers
echo    Автозапуск:   omniroute autostart enable
echo    Стоп:         freeclaude-stop
echo  ------------------------------------------------------------
echo    Запуск Claude Code:  freeclaude
echo  ============================================================
echo.
if defined OR_NOPAUSE exit /b 0
echo   Нажмите любую клавишу, чтобы закрыть окно...
pause >nul
exit /b 0

rem =====================================================================
rem                            СПРАВКА / ВЕРСИИ
rem =====================================================================
:show_help
echo.
echo  freeclaude - Claude Code через OmniRoute
echo.
echo  Использование:
echo    freeclaude                     запустить Claude Code через OmniRoute
echo    freeclaude --setup             только установить/проверить и поднять сервер
echo    freeclaude --dir C:\project    запустить Claude Code в папке проекта
echo    freeclaude --version           версии Node.js, OmniRoute, Claude Code
echo    freeclaude --help              эта справка
echo.
echo  Все прочие аргументы уходят в Claude Code:
echo    freeclaude -p "объясни этот код"
echo    freeclaude --continue
echo    freeclaude --model sonnet
echo.
echo  Переменные окружения:
echo    OMNIROUTE_PORT          порт шлюза, по умолчанию 20128
echo    OMNIROUTE_SERVER_HOST   адрес прослушивания, по умолчанию 127.0.0.1
echo    REQUIRE_API_KEY=true    требовать ключ OmniRoute для запросов к /v1
echo.
echo  Файлы рядом:
echo    install.bat              установка комплекта в C:\bat и автозапуск
echo    freeclaude-status.bat    статус, провайдеры, открыть дашборд
echo    freeclaude-stop.bat      остановить OmniRoute
echo    freeclaude-update.bat    обновить OmniRoute и Claude Code
echo.
echo  Ключ OmniRoute, если он нужен, кладите в файл:
echo    %OR_HOME%\.freeclaude\apikey.txt
echo.
echo  Справка по самому Claude Code:  claude --help
echo.
echo   Нажмите любую клавишу, чтобы закрыть окно...
pause >nul
exit /b 0

:show_version
echo.
echo  Компоненты freeclaude
echo  ---------------------
for /f "delims=" %%v in ('node -v 2^>nul') do echo    Node.js:     %%v
for /f "delims=" %%v in ('omniroute --version 2^>nul') do echo    OmniRoute:   %%v
for /f "delims=" %%c in ('claude --version 2^>nul') do echo    Claude Code: %%c
where node >nul 2>&1
if errorlevel 1 echo    Node.js:     не установлен
where omniroute >nul 2>&1
if errorlevel 1 echo    OmniRoute:   не установлен
where claude >nul 2>&1
if errorlevel 1 echo    Claude Code: не установлен
echo.
exit /b 0

rem =====================================================================
rem                              ПОДПРОГРАММЫ
rem =====================================================================

rem --- пути к свежеустановленным программам в текущей сессии -------------
:refresh_path
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%USERPROFILE%\.local\bin;%LOCALAPPDATA%\Microsoft\WinGet\Links;%LOCALAPPDATA%\Microsoft\WindowsApps;%APPDATA%\npm;%PATH%"
exit /b 0

rem --- Node.js 22.22.2+ / 24.x-26.x --------------------------------------
:node_version_ok
rem 0 - версия подходит, 1 - Node.js нет или версия не поддерживается
where node >nul 2>&1
if errorlevel 1 exit /b 1
node -e "var v=process.versions.node.split('.').map(Number);var ok=(v[0]===22&&(v[1]>22||(v[1]===22&&v[2]>=2)))||(v[0]>=24&&v[0]<=26);process.exit(ok?0:1)" >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

:ensure_node
call :node_version_ok
if not errorlevel 1 goto :node_ok
where node >nul 2>&1
if errorlevel 1 goto :node_install
echo   Node.js установлен, но версия не подходит для OmniRoute.
for /f "delims=" %%v in ('node -v 2^>nul') do echo   Текущая версия: %%v
echo   Подходят версии 22.22.2 и выше, а также 24.x, 25.x, 26.x.

:node_install
echo   Устанавливаю Node.js LTS через winget. Может появиться окно UAC - разрешите установку.
where winget >nul 2>&1
if errorlevel 1 goto :node_no_winget
winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements --silent
call :refresh_path
call :node_version_ok
if not errorlevel 1 goto :node_ok
echo   winget не смог поставить подходящую версию Node.js.

:node_no_winget
echo.
echo   [ОШИБКА] Node.js не установлен, а winget недоступен.
echo   1. Откройте https://nodejs.org/en/download
echo   2. Скачайте LTS-установщик .msi и установите его.
echo   3. Закройте это окно и запустите freeclaude снова.
start "" "https://nodejs.org/en/download"
exit /b 1

:node_ok
echo   Node.js: OK
exit /b 0

rem --- OmniRoute --------------------------------------------------------
:ensure_omniroute
where omniroute >nul 2>&1
if not errorlevel 1 goto :omniroute_ok
echo   OmniRoute не найден. Устанавливаю, это занимает 3-5 минут...
echo.
call npm install -g omniroute --no-fund --no-audit
call :refresh_path
where omniroute >nul 2>&1
if not errorlevel 1 goto :omniroute_ok
echo.
echo   [ОШИБКА] Не удалось установить OmniRoute.
echo   Проверьте подключение к интернету и выполните вручную:
echo     npm install -g omniroute
exit /b 1
:omniroute_ok
echo   OmniRoute: OK
exit /b 0

rem --- Claude Code ------------------------------------------------------
:ensure_claude
where claude >nul 2>&1
if not errorlevel 1 goto :claude_ok
if exist "%USERPROFILE%\.local\bin\claude.exe" goto :claude_ok
echo   Claude Code не найден. Устанавливаю...
where winget >nul 2>&1
if errorlevel 1 goto :claude_npm
winget install --id Anthropic.ClaudeCode -e --source winget --accept-source-agreements --accept-package-agreements --silent
call :refresh_path
where claude >nul 2>&1
if not errorlevel 1 goto :claude_ok
if exist "%USERPROFILE%\.local\bin\claude.exe" goto :claude_ok
echo   winget не смог поставить Claude Code, пробую npm...

:claude_npm
call npm install -g @anthropic-ai/claude-code --no-fund --no-audit
call :refresh_path
where claude >nul 2>&1
if not errorlevel 1 goto :claude_ok
if exist "%USERPROFILE%\.local\bin\claude.exe" goto :claude_ok
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps\claude.exe" goto :claude_ok
echo.
echo   [ОШИБКА] Claude Code не установился автоматически.
echo   Установите вручную одним из способов:
echo     winget install Anthropic.ClaudeCode
echo     npm install -g @anthropic-ai/claude-code
exit /b 1
:claude_ok
echo   Claude Code: OK
exit /b 0

rem --- сервер OmniRoute в фоне ------------------------------------------
:ensure_server
call :probe_health
if not errorlevel 1 goto :server_ok
echo   Запускаю OmniRoute в фоне на порту %OR_PORT%...
if defined OMNIROUTE_SERVER_HOST goto :server_start
set "OMNIROUTE_SERVER_HOST=127.0.0.1"
echo   Безопасность: шлюз слушает только localhost.
echo   Нужен доступ с других устройств - задайте OMNIROUTE_SERVER_HOST=0.0.0.0
:server_start
call omniroute serve --daemon --no-open --port %OR_PORT%
if errorlevel 1 goto :server_failed
echo   Ожидаю готовности сервера, обычно это 5-20 секунд...
node -e "var p=process.env.OMNIROUTE_PORT;var dl=Date.now()+120000;var dots=0;(function f(){fetch('http://127.0.0.1:'+p+'/api/monitoring/health',{signal:AbortSignal.timeout(3000)}).then(function(r){if(r.ok){process.exit(0)}throw new Error('status')}).catch(function(){if(Date.now()>dl){process.exit(1)}dots++;if(dots>=10){dots=0;process.stdout.write('.')}setTimeout(f,800)})})()"
if errorlevel 1 goto :server_failed
echo.
goto :server_ok

:server_failed
echo.
echo   [ОШИБКА] Сервер OmniRoute не ответил за 2 минуты.
echo   1. Проверьте, не занят ли порт:  netstat -ano ^| findstr :%OR_PORT%
echo   2. Запустите сервер в отдельном окне и посмотрите вывод:
echo        omniroute serve --port %OR_PORT%
echo   3. Диагностика:  omniroute doctor
exit /b 1

:server_ok
exit /b 0

:probe_health
node -e "fetch('http://127.0.0.1:'+process.env.OMNIROUTE_PORT+'/api/monitoring/health',{signal:AbortSignal.timeout(2000)}).then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})" >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

rem --- подключён ли хоть один провайдер --------------------------------
rem Источник истины - база подключений (providers list). Список из
rem providers status строится по счётчику истечения токенов и для ключей без
rem срока действия бывает пустым, хотя подключения есть.
:check_provider
set "OR_PROV=unknown"
call omniroute providers list --json > "%OR_TMP%\freeclaude_prov_list.json" 2>nul
call omniroute providers status --json > "%OR_TMP%\freeclaude_prov.json" 2>nul
node -e "var fs=require('fs');function read(p){try{var t=fs.readFileSync(p,'utf8');var i=t.indexOf('{');if(i<0)return null;return JSON.parse(t.slice(i))}catch(e){return null}}function cnt(j){if(!j)return -1;var l=j.providers||j.connections||j.list;if(Array.isArray(l))return l.length;if(typeof j.count==='number')return j.count;return -1}var n=Math.max(cnt(read(process.argv[1])),cnt(read(process.argv[2])));process.stdout.write(String(n))" "%OR_TMP%\freeclaude_prov_list.json" "%OR_TMP%\freeclaude_prov.json" > "%OR_TMP%\freeclaude_prov.txt" 2>nul
set /p OR_PROV=<"%OR_TMP%\freeclaude_prov.txt"
if "%OR_PROV%"=="0" goto :provider_missing
exit /b 0

:provider_missing
echo.
echo  ------------------------------------------------------------
echo    ВНИМАНИЕ: ни один провайдер ещё не подключён.
echo    Claude Code запустится, но запросы будет некуда отправлять.
echo.
echo    Что сделать сейчас:
echo      1. В открывшемся браузере: Providers -^> Kiro AI
echo      2. Add connection: Builder ID (вход) либо "API ключ"
echo         (ключ Kiro/CodeWhisperer вставляется в поле "API ключ")
echo      3. Войдите/подтвердите доступ, затем вернитесь сюда
echo      4. Вернитесь в это окно и запустите: freeclaude
echo.
echo    Дашборд: http://localhost:%OR_PORT%/dashboard/providers
echo    Проверить подключения: omniroute providers list
echo  ------------------------------------------------------------
echo.
start "" "http://localhost:%OR_PORT%/dashboard/providers"
exit /b 0

rem --- необязательный ключ OmniRoute из файла --------------------------
:load_api_key
set "OR_KEY="
if not exist "%OR_HOME%\.freeclaude\apikey.txt" exit /b 0
node -e "var fs=require('fs');try{var k=fs.readFileSync(process.argv[1],'utf8').trim();process.stdout.write(/^[A-Za-z0-9._-]+$/.test(k)?k:'')}catch(e){process.stdout.write('')}" "%OR_HOME%\.freeclaude\apikey.txt" > "%OR_TMP%\freeclaude_key.txt" 2>nul
set /p OR_KEY=<"%OR_TMP%\freeclaude_key.txt"
if not defined OR_KEY echo   Внимание: файл .freeclaude\apikey.txt найден, но ключ в нём выглядит некорректно.
exit /b 0

rem =====================================================================
:fatal
echo.
echo   Работа остановлена. Исправьте проблему выше и запустите freeclaude снова.
echo.
echo   Нажмите любую клавишу, чтобы закрыть окно...
pause >nul
exit /b 1
