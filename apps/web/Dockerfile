# Builds the vendored contestant app from local source (context = repo root).
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
RUN corepack enable
WORKDIR /app
COPY apps/web/ ./
RUN CI=true pnpm install --frozen-lockfile && \
    BETTER_AUTH_SECRET=build-time-dummy BETTER_AUTH_URL=http://localhost:3000 \
    pnpm build

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
RUN corepack enable
WORKDIR /app
# --chown, because the next line drops to `node`. Without it /app is
# root-owned and the unprivileged runtime user cannot create
# `.next/cache/fetch-cache`, which Next.js makes on its FIRST cached fetch —
# so the container booted fine, served fine, and logged
# `EACCES: permission denied, mkdir '/app/.next/cache/fetch-cache'` while
# silently caching nothing. Every `next: { revalidate: N }` fetch then re-hit
# upstream on every request, and the only evidence read like a Next.js
# internal rather than a permissions problem.
COPY --from=build --chown=node:node /app ./
# Build stamp for GET /health, so "did my fix reach the box?" is answerable
# from outside the container. Declared HERE, in the runtime stage only, and
# deliberately not in the build stage above: these change on every commit, and
# an ARG the build stage consumed would invalidate `pnpm install` and
# `pnpm build` on each one. Optional — absent reports "unknown"/null rather
# than failing (see apps/web/src/lib/app-version.ts).
ARG APP_BUILD_REV=
ARG APP_BUILT_AT=
ENV APP_BUILD_REV=$APP_BUILD_REV APP_BUILT_AT=$APP_BUILT_AT
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
CMD ["pnpm", "start"]
