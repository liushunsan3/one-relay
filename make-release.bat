@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File make-release.ps1
pause
