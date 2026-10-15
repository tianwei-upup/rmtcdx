# Build context: repository root. Build services/rmtcdx web assets first.
FROM node:22-alpine
WORKDIR /app/control
COPY control/package.json control/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY control/src ./src
COPY services/rmtcdx/apps/bridge/web-dist /app/web-dist
ENV RMT_HOST=0.0.0.0 RMT_PORT=3220 RMT_STATIC_DIR=/app/web-dist RMT_STATE_FILE=/data/cloud.json
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3220
CMD ["node", "src/cloud.mjs"]
