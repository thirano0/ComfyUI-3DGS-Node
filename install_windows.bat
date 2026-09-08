@echo off
rem Toshiki Hirano (Theoretical Hole Design), 2026
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_windows.ps1" %*
set "INSTALL_RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %INSTALL_RESULT%
