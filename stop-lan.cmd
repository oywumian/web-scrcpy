@echo off
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":4173" ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>nul
echo 已尝试停止 4173 端口上的局域网服务。
pause
