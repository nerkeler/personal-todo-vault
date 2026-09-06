FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.html USAGE.md server.js sqlite.js appConfig.js cloudBackup.js email.js migrate.js sql-wasm.js sql-wasm.wasm ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8238 \
    TODO_DATA_DIR=/data \
    TODO_NOTES_DIR=/data/notes \
    TODO_BACKUP_DIR=/data/backups \
    TODO_CONFIG_DIR=/config

VOLUME ["/data", "/config"]
EXPOSE 8238

CMD ["npm", "start"]
