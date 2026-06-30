# syntax=docker/dockerfile:1
#
# Container image for the daily Cloud Run Job. Multi-stage: compile the
# TypeScript workspace in a full build image, then ship only prod deps + the
# core/producer dist in a slim runtime image. The job runs the orchestrator from
# @saga-sync/producer; @saga-sync/core is resolved via the workspace symlink.
#
# pnpm is provisioned via corepack (pinned by the root package.json
# "packageManager" field). `pnpm install --prod` installs each package's declared
# deps under pnpm's strict (isolated) layout: the orchestrator resolves
# @saga-sync/core + viem from packages/producer/node_modules, and
# docker/fetch-config.mjs resolves @google-cloud/storage from the root (the root
# package declares it, since that script is the one that uses it).

# ---- build: compile the workspace ----
FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable
# Copy the lockfile + every workspace manifest first so the install layer caches
# on dependency changes, not source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json     packages/core/package.json
COPY packages/client/package.json   packages/client/package.json
COPY packages/producer/package.json packages/producer/package.json
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN pnpm run build

# ---- runtime: prod deps + compiled output ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json     packages/core/package.json
COPY packages/client/package.json   packages/client/package.json
COPY packages/producer/package.json packages/producer/package.json
RUN pnpm install --prod --frozen-lockfile
# Only core + producer are needed to run the job (the client lib is not).
COPY --from=build /app/packages/core/dist     packages/core/dist
COPY --from=build /app/packages/producer/dist packages/producer/dist
COPY docker ./docker
RUN chmod +x ./docker/entrypoint.sh
ENTRYPOINT ["/app/docker/entrypoint.sh"]
