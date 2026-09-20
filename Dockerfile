# syntax=docker/dockerfile:1

FROM node:26-alpine AS base
# git: the workspace manager clones with it. openssl: Prisma's query engine.
RUN apk add --no-cache git openssl tini
WORKDIR /repo
ENV NODE_ENV=production

FROM base AS build
ENV NODE_ENV=development
COPY package.json package-lock.json ./
COPY tsconfig.base.json tsconfig.build.json tsconfig.packages.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --no-audit --no-fund
RUN npm run db:generate && npm run build:backend
# Ship without the toolchain: build output is already emitted to dist/.
RUN npm prune --omit=dev

# api and worker share one image and differ only by entrypoint, so a build
# publishes exactly the same dependency set to both.
FROM base AS backend
COPY --from=build /repo ./
ENTRYPOINT ["/sbin/tini", "--"]

FROM backend AS api
CMD ["node", "apps/api/dist/index.js"]

FROM backend AS worker
# Checks run in a sandbox: docker CLI + the socket are mounted by compose when
# SANDBOX_MODE=docker, and this image never needs to talk to itself.
RUN apk add --no-cache docker-cli
CMD ["node", "apps/worker/dist/index.js"]
