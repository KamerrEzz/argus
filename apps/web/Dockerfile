# syntax=docker/dockerfile:1

FROM node:26-alpine AS base
WORKDIR /repo
ENV NODE_ENV=production

FROM base AS build
ENV NODE_ENV=development
# The whole workspace is needed: npm resolves every workspace's manifest, and
# Next only reads what it imports.
COPY . .
RUN npm ci --no-audit --no-fund
# Inlined into the client bundle, so it is a build argument, not a runtime one.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
# NODE_ENV stays development above so npm ci installs the toolchain, but
# `next build` must run in production: under development React resolves
# differently and prerendering /_global-error fails with
# "Cannot read properties of null (reading 'useContext')".
ENV NODE_ENV=production
RUN npm run build -w @acr/web

FROM base AS runtime
# standalone output only contains the server; assets and public files are copied in.
COPY --from=build /repo/apps/web/.next/standalone /repo
COPY --from=build /repo/apps/web/.next/static /repo/apps/web/.next/static
COPY --from=build /repo/apps/web/public /repo/apps/web/public
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
EXPOSE 3000
USER node
# COPY copies the *contents* of standalone into /repo, so the server lands at
# apps/web/server.js - not at the nested path it has inside .next.
CMD ["node", "apps/web/server.js"]
