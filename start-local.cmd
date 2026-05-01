@echo off
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"
echo Starting Dark Forest (frontend + API)...
echo Open http://localhost:5173 in your browser.
echo Press Ctrl+C to stop.
npm run dev
