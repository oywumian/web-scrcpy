$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodePath = 'C:\Program Files\nodejs\node.exe'
$logPath = Join-Path $workspace 'server.log'
$errorPath = Join-Path $workspace 'server.err.log'

Set-Location $workspace
& $nodePath server.mjs 1>> $logPath 2>> $errorPath
