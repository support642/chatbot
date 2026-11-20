# Node version is pinned here, independent of whatever runs on the EC2 host.
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node
EXPOSE 4001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-4001}/health || exit 1

CMD ["node", "src/server.js"]
