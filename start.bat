@echo off
rem 마인크래프트 서버 팜 포털 실행 (더블클릭)
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)
if not exist node_modules (
  echo 처음 실행: 필요한 패키지를 설치합니다...
  call npm install --omit=dev --no-fund --no-audit
)
node server\index.js
pause
