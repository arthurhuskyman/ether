#!/usr/bin/env bash
# V.82: сигнальный сервер «Мессенджера» на своём VPS одной командой (Ubuntu/Debian, root).
#   sudo bash deploy/vps-install.sh messenger.example.ru you@example.ru
#   sudo bash deploy/vps-install.sh - you@example.ru      ← без своего домена: 1-2-3-4.sslip.io по IP сервера
# Работает и на VPS в России: если get.docker.com или Docker Hub недоступны — Docker из репозитория дистрибутива и зеркало реестра.
# Нужно: домен с A-записью на IP этого сервера (или «-»); открытые порты 80, 443 (TCP), 3478 (TCP/UDP), 49160–49460 (UDP).
# Делает: ставит Docker (если нет), генерирует ключи VAPID и секрет TURN, пишет deploy/vps/.env, поднимает Caddy + сервер + coturn.
# Повторный запуск безопасен: существующий .env не перезаписывается (ключи push и секрет TURN сохраняются).
set -euo pipefail
DOMAIN="${1:-}"; EMAIL="${2:-}"; APP_DOMAIN="${3:-}" # V.85: третий аргумент — домен для своего зеркала приложения (необязательно)
# V.88.4: без своего домена — имя вида 1-2-3-4.sslip.io по IP сервера (Let's Encrypt его выдаёт); «-» вместо домена включает это явно
if [ "$DOMAIN" = "-" ] || { [ -z "$DOMAIN" ] && [ -n "$EMAIL" ]; }; then
  IP=$(curl -fsS -4 https://api.ipify.org 2>/dev/null || hostname -I | cut -d" " -f1); DOMAIN="$(echo "$IP" | tr . -).sslip.io"; echo "== Домен не указан — использую $DOMAIN"
fi
if [ -z "$EMAIL" ]; then echo "Использование: sudo bash deploy/vps-install.sh <домен или -> <email для Let's Encrypt> [домен зеркала приложения]"; exit 1; fi
[ "$(id -u)" -eq 0 ] || { echo "Запустите от root (sudo)."; exit 1; }
cd "$(dirname "$0")/vps"
if ! command -v docker >/dev/null 2>&1; then
  echo "== Ставлю Docker"; apt-get update -y && apt-get install -y ca-certificates curl
  # V.88.4: download.docker.com недоступен из России — тогда Docker из репозитория дистрибутива
  if ! { curl -fsSL --max-time 60 https://get.docker.com -o /tmp/get-docker.sh && sh /tmp/get-docker.sh; }; then
    echo "== get.docker.com недоступен — ставлю docker.io из репозитория дистрибутива"
    apt-get install -y docker.io && { apt-get install -y docker-compose-v2 || apt-get install -y docker-compose-plugin || apt-get install -y docker-compose; }
    systemctl enable --now docker || true
  fi
fi
# V.88.4: Docker Hub закрыт для российских IP — если образ не скачивается, включаем зеркало реестра (своё — через DOCKER_MIRROR=https://…)
if ! timeout 120 docker pull -q node:22-alpine >/dev/null 2>&1; then
  MIRRORS="${DOCKER_MIRROR:-https://mirror.gcr.io https://dockerhub.timeweb.cloud}"
  JSON=$(printf '"%s",' $MIRRORS); JSON="[${JSON%,}]"
  echo "== Docker Hub недоступен — включаю зеркала: $MIRRORS"
  mkdir -p /etc/docker; [ -f /etc/docker/daemon.json ] && cp /etc/docker/daemon.json /etc/docker/daemon.json.bak
  echo "{\"registry-mirrors\": $JSON}" > /etc/docker/daemon.json
  systemctl restart docker; sleep 3
  timeout 300 docker pull -q node:22-alpine >/dev/null || { echo "Не удалось скачать образы ни напрямую, ни через зеркала. Укажите своё: DOCKER_MIRROR=https://… sudo -E bash $0 $*"; exit 1; }
fi
# «docker compose» (плагин) или старый «docker-compose» (Debian)
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
if [ ! -f .env ]; then
  echo "== Генерирую ключи"
  VAPID=$(docker run --rm node:22-alpine sh -c "npx -y web-push@3 generate-vapid-keys --json")
  VPUB=$(echo "$VAPID" | sed -E 's/.*"publicKey":"([^"]+)".*/\1/'); VPRIV=$(echo "$VAPID" | sed -E 's/.*"privateKey":"([^"]+)".*/\1/')
  SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)
  cat > .env <<ENV
DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
TURN_SECRET=$SECRET
VAPID_PUBLIC=$VPUB
VAPID_PRIVATE=$VPRIV
VAPID_SUBJECT=mailto:$EMAIL
TURN_STATIC_URL=turn:$DOMAIN:3478,turn:$DOMAIN:3478?transport=tcp
TURN_STATIC_SECRET=$SECRET
TURN_TTL_SECONDS=86400
ALLOWED_ORIGIN=*
SFU_PUBLIC_IP=$(curl -fsS https://api.ipify.org || hostname -I | cut -d" " -f1)
ENV
  chmod 600 .env
fi
mkdir -p data caddy-data app
# V.85: своё зеркало приложения на этом же VPS (второй домен, A-запись на этот же IP). Приложение собирается
# tools/make-mirror.js с этим сервером первым в списке; раздаёт Caddy, без Node на хосте.
if [ -n "$APP_DOMAIN" ]; then
  echo "== Собираю зеркало приложения для https://$APP_DOMAIN"
  docker run --rm -v "$(cd ../.. && pwd)":/src -w /src node:22-alpine node tools/make-mirror.js --server "wss://$DOMAIN" --mirror "https://$APP_DOMAIN/" --out deploy/vps/app --no-zip
  grep -q '^APP_DOMAIN=' .env || echo "APP_DOMAIN=$APP_DOMAIN" >> .env
  cat > Caddyfile.app <<CADDY
$APP_DOMAIN {
	encode gzip
	root * /srv/app
	header /sw.js Cache-Control "no-cache"
	file_server
}
CADDY
else
  : > Caddyfile.app
fi
echo "== Запускаю"; $DC up -d --build
for i in $(seq 1 30); do if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then break; fi; sleep 4; done
if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then
  echo; echo "Готово. Адрес сервера для приложения: wss://$DOMAIN"
  [ -n "$APP_DOMAIN" ] && echo "Зеркало приложения: https://$APP_DOMAIN (добавьте его в mirrors в config.js основного сайта)"
  echo "Настройки → Приватность → Адрес сервера (или добавьте его в servers.json как зеркало)."
else
  echo "Сервер запущен, но https://$DOMAIN/health пока не отвечает: проверьте A-запись домена и порты 80/443. Логи: $DC logs -f"
fi
