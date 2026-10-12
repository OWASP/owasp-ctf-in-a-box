#!/usr/bin/env bats
#
# Every third-party action is pinned to a full commit, and every image a test
# harness runs is pinned to a digest. A tag can be moved under us; a pin
# cannot. The tag stays as a trailing comment (`@<sha> # vX.Y.Z`) because that
# comment is what Dependabot reads to keep the pin current.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
}

@test "every workflow 'uses:' is pinned to a 40-character commit with its tag as a comment" {
  unpinned="$(grep -nE '^[[:space:]]*(-[[:space:]]+)?uses:' "$ROOT"/.github/workflows/*.yml \
    | grep -vE 'uses:[[:space:]]+[^@[:space:]]+@[0-9a-f]{40}[[:space:]]+#[[:space:]]*v[0-9]' \
    | grep -vE 'uses:[[:space:]]+\./' || true)"
  total="$(grep -cE '^[[:space:]]*(-[[:space:]]+)?uses:' "$ROOT"/.github/workflows/*.yml | awk -F: '{ n += $NF } END { print n + 0 }')"
  if [ -n "$unpinned" ]; then
    echo "UNPINNED action(s):"
    echo "$unpinned"
  fi
  [ "$total" -gt 0 ] || { echo "found no 'uses:' lines at all — the pattern no longer matches the workflows"; return 1; }
  [ -z "$unpinned" ]
}

@test "every redis, srh and caddy image a script or workflow runs is digest-pinned" {
  refs="$(grep -nE '(^|[[:space:]"])(redis:[0-9a-z.-]+|hiett/serverless-redis-http:[0-9a-z.-]+|caddy:[0-9a-z.-]+)' \
    "$ROOT"/scripts/*.sh "$ROOT"/scripts/lib/*.sh "$ROOT"/.github/workflows/*.yml \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' \
    | grep -vE 'redis://' || true)"
  unpinned="$(grep -vE '@sha256:[0-9a-f]{64}' <<< "$refs" || true)"
  if [ -n "$unpinned" ]; then
    echo "UNPINNED image(s):"
    echo "$unpinned"
  fi
  [ -n "$refs" ] || { echo "found no image references at all — the pattern no longer matches"; return 1; }
  [ -z "$unpinned" ]
}
