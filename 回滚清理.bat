@echo off
chcp 65001 >nul
title 路由代理 - 回滚清理
echo 回滚到旧版本代码后，被自动踢出的站会保持停用状态。
echo 本脚本一键重新启用所有被自动踢出的站（disabledBy=auto），恢复正常。
choice /C YN /M "确认执行"
if errorlevel 2 exit /b
powershell -NoProfile -Command "$f='C:\Users\liushunshan\ZCodeProject\apps\router-proxy\providers.json'; $j=Get-Content $f -Raw -Encoding UTF8|ConvertFrom-Json; $n=0; $j|ForEach-Object{ if($_.disabledBy -eq 'auto'){ $_.enabled=$true; $_.disabledBy=$null; $n++ } }; [IO.File]::WriteAllText($f, ($j|ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false)); Write-Host ('已重新启用 '+$n+' 个被自动踢出的站')"
pause
