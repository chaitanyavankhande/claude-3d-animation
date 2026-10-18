@echo off
rem Double-click to start ATLAS on Windows.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS version from https://nodejs.org and try again. & pause & exit /b 1)
if not exist .env (copy .env.example .env >nul & echo Created .env - put your API key in it, save, then run this again. & notepad .env & exit /b 0)
if not exist node_modules (echo Installing, first run only... & call npm install || (pause & exit /b 1))
set ATLAS_OPEN=1
call npm start
pause
