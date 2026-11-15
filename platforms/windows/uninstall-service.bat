@echo off
chcp 65001 >nul 2>&1
title OFM Ollama Bridge - Uninstall Service
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-bridge-service.ps1" -Uninstall
echo.
pause
