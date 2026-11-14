@echo off
rem Opens Mission Control (http://127.0.0.1:4760). Starts app_server.py if it is not already running.
cd /d "%~dp0"
set "PY=C:\Users\aashw\AppData\Local\Python\pythoncore-3.15-64\python.exe"
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', 4760); $c.Close(); exit 0 } catch { exit 1 }"
if errorlevel 1 start "Mission Control" /min "%PY%" app_server.py
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:4760
