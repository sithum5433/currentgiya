FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.mjs app.js index.html lite.html style.css service-worker.js manifest.webmanifest ./
COPY lib ./lib
COPY data ./data
COPY scripts ./scripts

# Railway mounts its persistent volume at runtime; no VOLUME instruction is
# needed. The platform's volume is root-owned, so retain the image's default UID.
RUN mkdir -p /data && chmod 700 /data

EXPOSE 3000

CMD ["node", "server.mjs"]
