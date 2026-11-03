# syntax=docker/dockerfile:1.7

FROM node:24.10.0-alpine3.22 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts
COPY server ./server
# Builds public/index.html (the site) and server/dist (the API).
RUN npm run build

FROM node:24.10.0-alpine3.22 AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/public ./public
COPY server/migrations ./server/migrations
# The server grades with the same engine file the browser runs.
COPY src/engine.js ./src/engine.js

USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget --quiet --output-document=/dev/null http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server/dist/main.js"]
