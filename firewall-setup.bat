@echo off
rem 마인크래프트 서버 팜 - Windows 방화벽 규칙 등록 (더블클릭, 한 번만)
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0firewall-setup.ps1" %*
pause
