@echo off
chcp 65001 >nul 2>&1
title OFM Ollama Bridge - Start
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
pause
