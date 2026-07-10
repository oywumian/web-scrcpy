@echo off
title Web Scrcpy 局域网服务
cd /d "%~dp0"
set HOST=0.0.0.0
set PORT=4173
echo.
echo Web Scrcpy 局域网服务已准备启动
echo 本机地址:  http://127.0.0.1:4173
echo 局域网地址: http://你的电脑局域网IP:4173
echo.
echo 请保持这个窗口开启。
echo.
"C:\Program Files\nodejs\node.exe" server.mjs
