#!/bin/sh
# Установка вебхука на Ubuntu/Debian. Запускать от root из папки репозитория:
#   sudo sh deploy/install.sh
set -e
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs
fi
node -e 'if (+process.versions.node.split(".")[0] < 22) { console.error("Нужен Node.js 22+, сейчас " + process.version); process.exit(1) }'

mkdir -p /opt/alice/api
cp server.js package.json /opt/alice/
cp api/index.js /opt/alice/api/

mkdir -p /etc/alice && chmod 700 /etc/alice
if [ ! -f /etc/alice/env ]; then
  cp deploy/env.example /etc/alice/env
  echo "Создан /etc/alice/env — впишите туда GEMINI_API_KEY."
fi
chmod 600 /etc/alice/env

cp deploy/alice.service /etc/systemd/system/alice.service
systemctl daemon-reload
systemctl enable alice >/dev/null 2>&1
systemctl restart alice
sleep 1
systemctl is-active alice && curl -s 127.0.0.1:8090/ && echo
