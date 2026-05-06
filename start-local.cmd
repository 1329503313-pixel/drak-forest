@echo off
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"
echo [Dark Forest] 请确认 MySQL 已启动并可连接（见项目目录 .env）
echo   - Docker: docker compose up -d mysql
echo   - 或本机已安装 MySQL 并已创建库与用户（与 .env 一致）
echo.
echo Starting frontend + API...
echo Open http://localhost:5173 in your browser.
echo Press Ctrl+C to stop.
npm run dev
