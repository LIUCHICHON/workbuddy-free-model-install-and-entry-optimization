@echo off
chcp 65001 >nul 2>&1
title OFM Ollama Bridge - Install Service
cd /d "%~dp0"
echo.
echo 将把桥注册为 Windows 计划任务：登录自启 + 崩溃每分钟自愈
echo （需要先能成功运行一次 start.bat 并通过健康检查）
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-bridge-service.ps1"
echo.
pause
