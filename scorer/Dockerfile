# ctf scorer engine — one image, two modes (serve + judge).
#
# Default build bakes the vendored six-target rubric at /rubric:
#   docker build -t ghcr.io/<org>/score:latest scorer/
#
# Three rubric directories live under the build context, and RUBRIC_DIR picks one:
#   rubric.owasp/    vendored exec rubrics for all six targets (the default)
#   rubric.example/  the declarative-grammar tutorial (juice-shop.yaml)
#   rubric/          the organizer's own rubric — gitignored, never committed
#
# Private-rubric build. COPY can only read paths INSIDE the build context, and
# the context here is scorer/, so a rubric that lives outside the repo cannot be
# referenced with `../my-rubric`. Place it at scorer/rubric/ and point RUBRIC_DIR:
#   cp -r /path/to/private-rubric scorer/rubric
#   docker build -t ghcr.io/<org>/score:latest --build-arg RUBRIC_DIR=rubric scorer/
# RUBRIC_DIR is resolved relative to the context root (scorer/); keep it inside.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# docker-cli: the judge entrypoint drives sibling containers over the mounted
# docker.sock (boot the app under test, self-attach to the ctf network).
RUN apk add --no-cache docker-cli

WORKDIR /app

# yaml is the only runtime dependency; install from the lockfile first so the
# layer caches across src/rubric changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Bake the rubric. Default = the vendored six-target rubric; override with
# RUBRIC_DIR (see the rubric-directory note above).
ARG RUBRIC_DIR=rubric.owasp
COPY ${RUBRIC_DIR} /rubric

# `score` on PATH so `command: ["score", "serve"]` (docker-compose) and
# `score judge` (entrypoint) both work without hardcoding node paths.
RUN printf '#!/bin/sh\nexec node /app/src/index.js "$@"\n' > /usr/local/bin/score \
    && chmod +x /usr/local/bin/score

# Judge entrypoint. score-action overrides the entrypoint to this path
# (--entrypoint /usr/local/bin/entrypoint.sh); serve mode uses the CMD below.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Per-target bring-up scripts, sourced by entrypoint.sh when TARGET matches.
COPY entrypoints /usr/local/lib/ctf/entrypoints

# Bare `docker run` of the image = leaderboard API (compose overrides nothing).
CMD ["score", "serve"]
