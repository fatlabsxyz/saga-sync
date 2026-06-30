# syntax=docker/dockerfile:1
#
# Container image for the daily Cloud Run Job. Multi-stage: compile the
# TypeScript workspace in a full build image, then ship only prod deps + the
# core/producer dist in a slim runtime image. The job runs the orchestrator from
# @saga-sync/producer; @saga-sync/core is resolved via the workspace symlink.
#
# `npm ci --omit=dev` keeps optionalDependencies, so @google-cloud/storage (the
# gs:// store + config fetch) is present even though it stays optional for
# disk-only library consumers.

# ---- build: compile the workspace ----
FROM node:20-slim AS build
WORKDIR /app
# Copy every workspace manifest first so `npm ci` layer-caches on dependency
# changes, not source changes.
COPY package.json package-lock.json ./
COPY packages/core/package.json     packages/core/package.json
COPY packages/client/package.json   packages/client/package.json
COPY packages/producer/package.json packages/producer/package.json
RUN npm ci
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm run build

# ---- runtime: prod deps + compiled output ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json     packages/core/package.json
COPY packages/client/package.json   packages/client/package.json
COPY packages/producer/package.json packages/producer/package.json
RUN npm ci --omit=dev && npm cache clean --force
# Only core + producer are needed to run the job (the client lib is not).
COPY --from=build /app/packages/core/dist     packages/core/dist
COPY --from=build /app/packages/producer/dist packages/producer/dist
COPY docker ./docker
RUN chmod +x ./docker/entrypoint.sh
ENTRYPOINT ["/app/docker/entrypoint.sh"]
