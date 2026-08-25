@echo off
chcp 65001 >nul
title 路由代理 - 回滚到旧版
echo ============================================
echo   回滚到旧版（无托盘/无面板的黑窗口版本）
echo ============================================
echo.
echo 说明：只回滚程序代码，providers.json 等数据保持现状。
echo 新版文件（supervisor.js 等）保留不删，之后可再次切换回来。
choice /C YN /M "确认回滚"
if errorlevel 2 exit /b
echo.
echo [1/4] 停止新版（看护进程及其子进程树）...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*supervisor.js*' } | ForEach-Object { Write-Host ('  停止看护树 PID ' + $_.ProcessId); & taskkill /PID $_.ProcessId /T /F | Out-Null }; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*router-proxy*router.js*' } | ForEach-Object { Write-Host ('  停止 router PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }"
echo [2/4] 恢复旧版 router.js（备份于 2026-08-16）...
copy /y "C:\Users\liushunshan\ZCodeProject\apps\router-proxy-backup-20260816\router.js" "C:\Users\liushunshan\ZCodeProject\apps\router-proxy\router.js"
echo [3/4] 以旧方式启动（最小化黑窗口）...
start /min "" cmd /c "cd /d C:\Users\liushunshan\ZCodeProject\apps\router-proxy && node router.js"
echo [4/4] 完成。关闭那个最小化的黑窗口即停止旧版服务。
echo 如需再切回新版：改回新版代码需从备份目录复制新版文件，或重跑安装。
echo （最简单：回滚前先把当前 router.js 复制一份留着）
pause
