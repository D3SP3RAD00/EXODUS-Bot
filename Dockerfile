FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DATA_DIRECTORY=/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && mkdir -p /data \
    && chown node:node /data

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/exodus-entrypoint
RUN chmod 0755 /usr/local/bin/exodus-entrypoint

USER node
VOLUME ["/data"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["exodus-entrypoint"]
CMD ["node", "dist/index.js"]
