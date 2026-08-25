# One-Relay 发布包构建（白名单复制，绝不含 key 与个人数据）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
$dist = Join-Path $here 'dist\one-relay'

if (Test-Path (Join-Path $here 'dist')) { Remove-Item (Join-Path $here 'dist') -Recurse -Force }
New-Item -ItemType Directory -Path $dist | Out-Null

$files = @(
  'router.js', 'supervisor.js', 'tray.ps1', 'start-hidden.vbs', 'icon.ico',
  'README.md', 'LICENSE', 'providers.example.json',
  '使用说明.md',
  '启动路由代理.bat', '平滑重启.bat', '设为开机自启.bat'
)
foreach ($f in $files) {
  if (Test-Path $f) { Copy-Item $f $dist -Force }
  else { Write-Host "缺失: $f" -ForegroundColor Yellow }
}
Copy-Item (Join-Path $here 'public') (Join-Path $dist 'public') -Recurse -Force

# 敏感检查：发布包里绝不出现真实配置
$forbidden = @('providers.json', 'settings.json', 'memory.json', 'stats.json')
$bad = Get-ChildItem $dist -Recurse -File | Where-Object { $forbidden -contains $_.Name -or $_.Name -like '*.bak*' -or $_.Name -like '*key*' -and $_.Name -notlike '*example*' }
if ($bad) {
  Write-Host '发现敏感文件，中止！' -ForegroundColor Red
  $bad | ForEach-Object { Write-Host ('  ' + $_.FullName) }
  exit 1
}
$count = (Get-ChildItem $dist -Recurse -File).Count
Write-Host ("发布包构建完成: dist\one-relay（{0} 个文件，敏感检查通过）" -f $count) -ForegroundColor Green
