# scorer/entrypoints/vulnerableapp.sh
# VulnerableApp bring-up. Sourced by entrypoint.sh.
#
# A single Spring Boot container serving on 9090 with no external dependencies.
# The generic boot would work, except the rubric's tests read VULNERABLEAPP_URL
# in addition to APP_URL, and the app needs its startup grace period before the
# first challenge child spawns — 110 children at concurrency 8 would otherwise
# all race an unready app and trip the unreachable early-abort.
if [ -n "${APP_IMAGE:-}" ]; then
  # pins: APP_IMAGE is chosen, and pinned, by whoever passes it in
  docker pull "$APP_IMAGE" >/dev/null
  IMAGE="$APP_IMAGE"
elif [ -f "${GITHUB_WORKSPACE:-/github/workspace}/Dockerfile" ]; then
  docker build -t ctf-app-under-test "${GITHUB_WORKSPACE:-/github/workspace}" >/dev/null
  # pins: built locally from the PR checkout, never pulled
  IMAGE=ctf-app-under-test
else
  echo "vulnerableapp: need APP_IMAGE or a workspace Dockerfile" >&2
  exit 1
fi

# pins: the app under test: APP_IMAGE, or an image built from the PR checkout
docker run -d --rm \
  --network "$NETWORK" \
  --network-alias "$APP_HOST" \
  --name "$APP_CONTAINER" \
  "$IMAGE" >/dev/null
BOOTED="$APP_CONTAINER"
