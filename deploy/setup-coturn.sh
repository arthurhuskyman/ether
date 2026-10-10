#!/usr/bin/env bash
# Установка TURN-сервера (coturn) для «Эфира» на Ubuntu/Debian.
# Запуск от root на VPS с БЕЛЫМ (не серым) IPv4:   sudo bash setup-coturn.sh [домен]
# Домен нужен только для TLS (turns:…:5349); без домена ставится TURN по UDP/TCP на 3478.
# Не проверялось на конкретных хостерах — читай вывод команд и сверяйся с README.
set -euo pipefail
DOMAIN="${1:-}"
[ "$(id -u)" = 0 ] || { echo "Запусти от root (sudo)"; exit 1; }

PUBIP="$(curl -4 -fsS https://api.ipify.org || true)"
[ -n "$PUBIP" ] || PUBIP="$(hostname -I | awk '{print $1}')"
echo "Публичный IP: $PUBIP"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y coturn curl openssl
[ -n "$DOMAIN" ] && apt-get install -y certbot

TURN_USER="ether"
TURN_PASS="$(openssl rand -hex 16)"

CERT_LINES=""
if [ -n "$DOMAIN" ]; then
  # Домен должен уже указывать (A-запись) на этот сервер; порт 80 должен быть свободен на время выпуска.
  certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email
  CERT_LINES="tls-listening-port=5349
cert=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
pkey=/etc/letsencrypt/live/$DOMAIN/privkey.pem"
  # coturn работает от пользователя turnserver — даём читать сертификат
  setfacl -R -m u:turnserver:rx /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || chmod -R a+rX /etc/letsencrypt/live /etc/letsencrypt/archive
fi

cat > /etc/turnserver.conf <<CONF
listening-port=3478
external-ip=$PUBIP
min-port=49152
max-port=49300
fingerprint
lt-cred-mech
user=$TURN_USER:$TURN_PASS
realm=ether
no-multicast-peers
no-cli
# запрет релея во внутренние сети (безопасность)
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
$CERT_LINES
CONF

sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
systemctl enable coturn
systemctl restart coturn
sleep 1
systemctl --no-pager --lines=5 status coturn || true

URLS="turn:$PUBIP:3478"
[ -n "$DOMAIN" ] && URLS="$URLS,turns:$DOMAIN:5349?transport=tcp"

cat <<OUT

================ ГОТОВО ================
Открой в файрволе хостера/ufw: 3478 (UDP и TCP), 5349 (TCP, если есть домен), 49152-49300 (UDP).

Значения для Render → Environment:
TURN_STATIC_URL=$URLS
TURN_STATIC_USERNAME=$TURN_USER
TURN_STATIC_PASSWORD=$TURN_PASS

После сохранения Render перезапустится. Затем в приложении: Отладка → Проверить TURN.
(Сервер сам добавит вариант ?transport=tcp к turn:-адресу.)
OUT
