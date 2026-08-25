@echo off
chcp 65001 >nul
title 路由代理 - 切换到新版
echo ============================================
echo   路由代理切换到新版（托盘常驻 + 管理面板）
echo ============================================
echo.
echo 注意：切换会中断服务几秒，请确认当前没有正在进行的 AI 对话。
choice /C YN /M "确认现在切换"
if errorlevel 2 exit /b
echo.
echo [1/3] 停止旧版路由进程...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*router-proxy*router.js*' } | ForEach-Object { Write-Host ('  已停止 PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }"
echo [2/3] 启动新版（托盘常驻）...
start "" wscript.exe "C:\Users\liushunshan\ZCodeProject\apps\router-proxy\start-hidden.vbs"
echo [3/3] 等待服务上线（最多 15 秒）...
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 15;$i++){ Start-Sleep 1; try{ $r=Invoke-WebRequest 'http://127.0.0.1:3099/v1/models' -Headers @{Authorization='Bearer sk-router'} -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200){$ok=$true; break} }catch{} }; if($ok){ Write-Host '  ✅ 新版已上线' -ForegroundColor Green } else { Write-Host '  ⚠️ 等待超时：请看右下角托盘是否有图标，或查看 logs\ 目录' -ForegroundColor Yellow }"
echo.
echo 完成！托盘出现蓝色「路」图标即成功，双击图标打开管理面板。
echo 客户端接入不变：http://127.0.0.1:3099/v1  key: sk-router
pause
