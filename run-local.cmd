@echo off
cd /d "%~dp0"
set HOST=0.0.0.0
set PORT=4173
"C:\Program Files\nodejs\node.exe" server.mjs
