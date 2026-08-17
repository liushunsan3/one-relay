@echo off
chcp 65001 >nul
title 路由代理 - 启动
cd /d "%~dp0"
start "" wscript.exe "start-hidden.vbs"
echo 已在后台启动路由代理（右下角托盘出现蓝色图标）。
echo 若图标未出现：等 3 秒再看；仍无则安装 Node.js 后重试。
timeout /t 3 >nul
