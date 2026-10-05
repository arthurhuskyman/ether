# killer-features-backlog 0.2 — "свой сервер" как оформленная фича.
# Образ для signaling-сервера Эфира: сам не видит содержимого сообщений
# (сквозное шифрование), но знает, кто онлайн, и держит офлайн-почтовый
# ящик (TTL: текст 5 минут, файлы 48 часов) — см. комментарий в server.js.
FROM node:18-alpine

WORKDIR /app

# Отдельно копируем package*.json, чтобы слой с зависимостями кешировался
# Docker'ом и не пересобирался при каждом изменении server.js.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "server.js"]
