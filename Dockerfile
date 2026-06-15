# syntax=docker/dockerfile:1
#
# Container image for the daily Cloud Run Job. Multi-stage: compile TypeScript in
# a full build image, then ship only prod deps + dist in a slim runtime image.
#
# `npm ci --omit=dev` keeps optionalDependencies, so @google-cloud/storage (the
# gs:// store + config fetch) is present even though it stays optional for
# disk-only library consumers.

# ---- build: compile TypeScript ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime: prod deps + compiled output ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docker ./docker
RUN chmod +x ./docker/entrypoint.sh
ENTRYPOINT ["/app/docker/entrypoint.sh"]
