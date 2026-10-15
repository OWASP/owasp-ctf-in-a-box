# scorer/entrypoints/vampi.sh
# VAmPI bring-up. Sourced by entrypoint.sh.
#
# VAmPI is a single Flask container with a self-contained SQLite database; the
# rubric's own createDb() helper seeds it over HTTP, so there is no database
# sibling to start. The only thing this adds over the generic path is the
# vulnerable-mode env var — VAmPI ships a hardened mode, and scoring a hardened
# instance would pass every probe against an unpatched fork.
if [ -n "${APP_IMAGE:-}" ]; then
  # pins: APP_IMAGE is chosen, and pinned, by whoever passes it in
  docker pull "$APP_IMAGE" >/dev/null
  IMAGE="$APP_IMAGE"
elif [ -f "${GITHUB_WORKSPACE:-/github/workspace}/Dockerfile" ]; then
  docker build -t ctf-app-under-test "${GITHUB_WORKSPACE:-/github/workspace}" >/dev/null
  # pins: built locally from the PR checkout, never pulled
  IMAGE=ctf-app-under-test
else
  echo "vampi: need APP_IMAGE or a workspace Dockerfile" >&2
  exit 1
fi

# pins: the app under test: APP_IMAGE, or an image built from the PR checkout
docker run -d --rm \
  --network "$NETWORK" \
  --network-alias "$APP_HOST" \
  --name "$APP_CONTAINER" \
  -e vulnerable=1 \
  "$IMAGE" >/dev/null
BOOTED="$APP_CONTAINER"
