#!/bin/sh
# 마인크래프트 서버 팜 포털 실행 (Linux). 사용법: sh start.sh   (또는 chmod +x start.sh 후 ./start.sh)
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 설치되어 있지 않습니다. Node.js 18.17 이상을 설치한 뒤 다시 실행하세요. (예: sudo apt install nodejs npm)"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "처음 실행: 필요한 패키지를 설치합니다..."
  npm install --omit=dev --no-fund --no-audit
fi

# exec: the portal itself receives Ctrl+C / SIGTERM, saves and stops every Minecraft server, then exits.
exec node server/index.js
