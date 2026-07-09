Set shell = CreateObject("WScript.Shell")
workspace = "C:\Users\P1\Documents\web scrcpy"
command = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & workspace & "\run-local.ps1"""
shell.Run command, 0, False
