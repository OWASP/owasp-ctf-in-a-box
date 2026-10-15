# scorer/entrypoints/juice-shop.sh
# Juice Shop bring-up. Sourced by entrypoint.sh.
#
# Single Node container on 3000, no dependencies. Unlike the other five, Juice
# Shop forks carry a root Dockerfile, so the PR-patch path (build the
# contestant's checked-out code) is the normal case and APP_IMAGE is the
# fallback for scoring a prebuilt patched image.
if [ -n "${APP_IMAGE:-}" ]; then
  # pins: APP_IMAGE is chosen, and pinned, by whoever passes it in
  docker pull "$APP_IMAGE" >/dev/null
  IMAGE="$APP_IMAGE"
elif [ -f "${GITHUB_WORKSPACE:-/github/workspace}/Dockerfile" ]; then
  docker build -t ctf-app-under-test "${GITHUB_WORKSPACE:-/github/workspace}" >/dev/null
  # pins: built locally from the PR checkout, never pulled
  IMAGE=ctf-app-under-test
else
  echo "juice-shop: need APP_IMAGE or a workspace Dockerfile" >&2
  exit 1
fi

# pins: the app under test: APP_IMAGE, or an image built from the PR checkout
docker run -d --rm \
  --network "$NETWORK" \
  --network-alias "$APP_HOST" \
  --name "$APP_CONTAINER" \
  -e NODE_ENV=unsafe \
  "$IMAGE" >/dev/null
BOOTED="$APP_CONTAINER"
