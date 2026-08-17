# Generic image for the TypeScript data seller example. The corpus is
# decompressed at build time so the process can run with a read-only root
# filesystem in Kubernetes.
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY fixtures ./fixtures
COPY tsconfig.json tsconfig.runtime.json ./

RUN npm run build && \
    ./node_modules/.bin/tsc -p tsconfig.runtime.json && \
    node -e 'const fs = require("node:fs"); const zlib = require("node:zlib"); fs.writeFileSync("fixtures/places-ca-ny.csv", zlib.gunzipSync(fs.readFileSync("fixtures/places-ca-ny.csv.gz")))' && \
    npm prune --omit=dev && \
    npm cache clean --force

FROM node:22-bookworm-slim

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# verifierBundleHash intentionally commits to the published TypeScript source,
# so keep those exact files beside the emitted JavaScript it executes.
COPY --from=build /app/src ./dist
COPY --from=build /app/fixtures ./fixtures

ENV CORPUS_PATH=/app/fixtures/places-ca-ny.csv

USER node
EXPOSE 9998
CMD ["node", "dist/server.js"]
