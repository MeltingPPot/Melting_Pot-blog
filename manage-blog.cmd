@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [Jekyll Template] Python was not found.
  echo Install Python 3.10 or newer, then run this file again.
  pause
  exit /b 1
)

python tools\blog-admin\server.py
if errorlevel 1 pause
