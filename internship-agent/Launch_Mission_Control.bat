@echo off
rem Mission Control in one double-click (or one command: Launch_Mission_Control.bat).
rem Starts app_server.py (FastAPI) if it is not already running, then opens http://127.0.0.1:4760.
rem A .bat file is not subject to PowerShell's execution policy, and every path is relative to this folder.
setlocal
cd /d "%~dp0"

rem ---- find Python: the install this laptop uses, else the py launcher, else python on PATH
set "PY=C:\Users\aashw\AppData\Local\Python\pythoncore-3.15-64\python.exe"
set "PYFLAGS="
if exist "%PY%" goto have_python
where py >nul 2>nul
if not errorlevel 1 (
  set "PY=py"
  set "PYFLAGS=-3"
  goto have_python
)
set "PY=python"
:have_python

rem ---- first run: install FastAPI / uvicorn and the rest of requirements.txt
"%PY%" %PYFLAGS% -c "import fastapi, uvicorn, openpyxl, playwright" >nul 2>nul
if errorlevel 1 (
  echo Installing Python packages from requirements.txt ...
  "%PY%" %PYFLAGS% -m pip install --disable-pip-version-check -q -r requirements.txt
  if errorlevel 1 (
    echo Could not install the Python packages. Run:  "%PY%" %PYFLAGS% -m pip install -r requirements.txt
    pause
    exit /b 1
  )
)

rem ---- the page is prebuilt in mission_control_ui\dist; rebuild only if it is missing and Node is installed
if not exist "mission_control_ui\dist\index.html" (
  where npm >nul 2>nul
  if not errorlevel 1 (
    echo Building the Mission Control page ...
    call npm --prefix mission_control_ui ci --no-audit --no-fund
    call npm --prefix mission_control_ui run build
  )
)

rem ---- start the server unless it is already up, then wait for it and open the page
"%PY%" %PYFLAGS% -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1',4760))==0 else 1)"
if errorlevel 1 start "Mission Control" /min "%PY%" %PYFLAGS% app_server.py
for /l %%i in (1,1,30) do (
  "%PY%" %PYFLAGS% -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1',4760))==0 else 1)"
  if not errorlevel 1 goto open_page
  timeout /t 1 /nobreak >nul
)
echo Mission Control did not start. Run  "%PY%" %PYFLAGS% app_server.py  in this folder to see why.
pause
exit /b 1

:open_page
start "" http://127.0.0.1:4760
endlocal
