@echo off
chcp 65001 >nul
title 路由代理 - 平滑重启
cd /d "%~dp0"
echo 正在平滑重启路由代理（退避计数清零，几秒完成）...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*supervisor.js*' } | ForEach-Object { & taskkill /PID $_.ProcessId /T /F | Out-Null }"
ping -n 2 127.0.0.1 >nul
start "" wscript.exe "start-hidden.vbs"
ping -n 6 127.0.0.1 >nul
powershell -NoProfile -Command "$key='sk-router'; try{ $s=Get-Content 'settings.json' -Raw -Encoding UTF8|ConvertFrom-Json; if($s.apiKey){$key=$s.apiKey} }catch{}; $ok=$false; for($i=0;$i -lt 10;$i++){ try{ $r=Invoke-WebRequest 'http://127.0.0.1:3099/v1/models' -Headers @{Authorization='Bearer '+$key} -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200){$ok=$true; break} }catch{}; Start-Sleep 1 }; if($ok){ Write-Host '✅ 重启完成，服务正常' -ForegroundColor Green } else { Write-Host '⚠️ 服务未上线，请查看 logs 目录' -ForegroundColor Yellow }"
pause
