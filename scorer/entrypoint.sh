#!/bin/sh
# ctf scorer — judge entrypoint (score-action contract).
#
# Runs inside the scorer image with docker.sock mounted. Boots the app under
# test as a SIBLING container on the ctf network — a plain user-defined bridge,
# NOT --internal, with no host ports published (see boot_app) — then runs the
# declarative rubric probes against it and writes ctf-score.md into CTF_OUT_DIR
# (a dedicated dir OUTSIDE the PR checkout — the consumer workflow reads the
# report only from there, only on success, so the bot comment can't be forged).
#
# Env in (from score-action / the consumer workflow):
#   TARGET             rubric target id (required) — names the app container
#   APP_URL            where the app answers, ON the ctf network (required)
#   APP_IMAGE          optional prebuilt app image to pull + run
#   NETWORK            ctf docker network (default ctfnet)
#   GITHUB_WORKSPACE   PR checkout (holds the PR's Dockerfile for the patch path)
#   CTF_OUT_DIR        where ctf-score.md is written (default: GITHUB_WORKSPACE)
#   GITHUB_EVENT_PATH  webhook payload (author/pr/sha)
set -eu

NETWORK="${NETWORK:-ctfnet}"
: "${TARGET:?entrypoint: TARGET is required}"
: "${APP_URL:?entrypoint: APP_URL is required}"

# Container the app under test runs as. Derived from TARGET so cleanup can find
# it; the network alias (below) is what APP_URL actually resolves to.
APP_CONTAINER="ctf-app-$(printf '%s' "$TARGET" | tr -c 'a-zA-Z0-9_.-' '-')"

# Host portion of APP_URL (strip scheme, path, port) — the sibling app joins the
# network under this alias so APP_URL resolves regardless of the container name.
APP_HOST="$(printf '%s' "$APP_URL" | sed -e 's,^[a-zA-Z][a-zA-Z0-9+.-]*://,,' -e 's,[/:].*$,,')"

BOOTED=""
cleanup() {
  # Only tear down containers THIS script booted (strategies a/b). Strategy c
  # uses an organizer-managed app we must not touch. EXTRA_CONTAINERS is set by
  # a per-target bring-up script that starts siblings of its own (DVWA's db).
  if [ -n "$BOOTED" ]; then
    docker rm -f "$BOOTED" >/dev/null 2>&1 || true
  fi
  for c in ${EXTRA_CONTAINERS:-}; do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

# Ensure the ctf network exists. Tolerate the race where a parallel job (or a
# previous run) already created it.
docker network inspect "$NETWORK" >/dev/null 2>&1 \
  || docker network create "$NETWORK" >/dev/null 2>&1 \
  || true

# score-action starts the scorer with a plain `docker run` (no --network), so
# the scorer lands on the default bridge and cannot reach the app it boots.
# Self-attach to the ctf network — the container id is the hostname. Tolerate
# "already connected" (compose/CI may have wired it, or a retry re-runs this).
docker network connect "$NETWORK" "$(hostname)" >/dev/null 2>&1 || true

boot_app() {
  # Publishes NO host ports: nothing on the runner's interfaces answers for the
  # app, and only containers on $NETWORK resolve APP_URL. That is the whole
  # contract — $NETWORK is a plain bridge (a bare `docker network create`, above
  # and in the consumer workflow), not --internal, so the app can still reach
  # the internet and the runner host can still reach the container's bridge IP.
  # pins: the app under test: APP_IMAGE, or an image built from the PR checkout
  docker run -d --rm \
    --network "$NETWORK" \
    --network-alias "$APP_HOST" \
    --name "$APP_CONTAINER" \
    "$1" >/dev/null
  BOOTED="$APP_CONTAINER"
}

# Per-target bring-up. Targets needing more than "run one container" (a database
# sibling, a schema init, a readiness handshake) ship a script here. It runs
# INSTEAD of the generic boot below and is responsible for leaving the app
# reachable at APP_URL on $NETWORK.
TARGET_BOOT="/usr/local/lib/ctf/entrypoints/${TARGET}.sh"
if [ -f "$TARGET_BOOT" ]; then
  echo "entrypoint: booting $TARGET via its bring-up script"
  # shellcheck disable=SC1090
  NETWORK="$NETWORK" APP_HOST="$APP_HOST" APP_URL="$APP_URL" \
    APP_CONTAINER="$APP_CONTAINER" APP_IMAGE="${APP_IMAGE:-}" \
    . "$TARGET_BOOT"
  exec score judge
fi

if [ -n "${APP_IMAGE:-}" ]; then
  # (a) Prebuilt image — pull and run as a sibling.
  echo "entrypoint: booting app from APP_IMAGE=$APP_IMAGE"
  # pins: APP_IMAGE is chosen, and pinned, by whoever passes it in
  docker pull "$APP_IMAGE" >/dev/null
  boot_app "$APP_IMAGE"
elif [ -f "${GITHUB_WORKSPACE:-/github/workspace}/Dockerfile" ]; then
  # (b) PR-patch path: build the contestant's checked-out code. The untrusted
  # code runs ONLY inside the sibling container on $NETWORK — never on the
  # runner host and never with host ports published (boot_app publishes none).
  echo "entrypoint: building app under test from PR workspace Dockerfile"
  docker build -t ctf-app-under-test "${GITHUB_WORKSPACE:-/github/workspace}" >/dev/null
  boot_app ctf-app-under-test
else
  # (c) Organizer-managed app already reachable at APP_URL — do not boot.
  echo "entrypoint: no APP_IMAGE and no workspace Dockerfile — assuming APP_URL is already up"
fi

# Readiness polling lives in the engine (waitForApp).
exec score judge
