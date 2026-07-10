$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path
$cloudflared = Join-Path $workspace 'cloudflared\cloudflared.exe'

if (!(Test-Path $cloudflared)) {
  Write-Host '未找到 cloudflared，请先把 cloudflared.exe 放到 cloudflared 文件夹内。'
  exit 1
}

Set-Location $workspace
& $cloudflared tunnel --url http://127.0.0.1:4173
