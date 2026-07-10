Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
workspace = fso.GetParentFolderName(WScript.ScriptFullName)
command = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & workspace & "\run-local.ps1"""
shell.Run command, 0, False
