@echo off
cd /d "%~dp0"

set "PYEXE=%~dp0python\python.exe"
if not exist "%PYEXE%" set "PYEXE=python"

rem Use uncommon port 38080 by default; override via APP_PORT if needed.
rem main.py reads the same APP_PORT variable, so both stay in sync.
if not defined APP_PORT set "APP_PORT=38080"

rem Stop previous instances of this app that still hold the port.
rem Only processes whose exe path or command line belongs to this project are killed.
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %APP_PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $procId = $_; try { $p = Get-Process -Id $procId -ErrorAction Stop; $cmd = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $procId) -ErrorAction SilentlyContinue).CommandLine; if (($p.Path -and $p.Path -like '%~dp0*') -or ($cmd -and $cmd -like '*Infinite_Canvas*')) { Write-Host ('[i] Stopping previous instance (PID ' + $procId + ')...'); Stop-Process -Id $procId -Force } else { Write-Host ('[!] Port %APP_PORT% is held by ' + $p.ProcessName + ' (PID ' + $procId + '), which is not this app.') } } catch {} }"

netstat -ano | findstr ":%APP_PORT% " | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo.
    echo [ERROR] Port %APP_PORT% is still occupied by another program.
    echo         Please close it manually, then run this script again.
    pause
    exit /b 1
)

echo Starting ComfyUI-API-Modelscope...
echo Visit: http://127.0.0.1:%APP_PORT%/
echo Press Ctrl+C to stop.
echo.

start /b cmd /c "timeout /t 3 /nobreak >nul && start http://127.0.0.1:%APP_PORT%/"
"%PYEXE%" main.py

echo.
echo Server stopped.
pause
