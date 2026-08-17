@echo off
chcp 65001 >nul
title 路由代理 - 开机自启
cd /d "%~dp0"
powershell -NoProfile -Command "$vbs=(Resolve-Path 'start-hidden.vbs').Path; $ws=New-Object -ComObject WScript.Shell; $lnk=$ws.CreateShortcut([Environment]::GetFolderPath('Startup')+'\路由代理.lnk'); $lnk.TargetPath='C:\Windows\System32\wscript.exe'; $lnk.Arguments='\"'+$vbs+'\"'; $lnk.WorkingDirectory=(Get-Location).Path; $lnk.IconLocation=(Resolve-Path 'icon.ico').Path+',0'; $lnk.Description='路由代理 One-Relay'; $lnk.WindowStyle=7; $lnk.Save(); Write-Host '✅ 已设置开机自启（启动文件夹快捷方式，无窗口后台启动）'"
echo.
echo 取消自启：删除 开始菜单→启动 文件夹里的「路由代理」快捷方式即可。
pause
