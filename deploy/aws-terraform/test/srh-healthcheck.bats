#!/usr/bin/env bats
#
# EXECUTES the srh health check ECS runs, against the pinned srh image and a
# real Redis.
#
# ecs.tf reads the command verbatim from ../srh-healthcheck.sh, and
# stack.tftest.hcl asserts the rendered task definition equals that file. This
# suite closes the other half: it runs the same file INSIDE the srh image
# `srh_image` pins (the digest is read from variables.tf, never copied here)
# and checks that the probe tells a working data path from a broken one. The
# first version of this check called `GET /ping`, which the pinned srh answers
# with a 404 whatever the token or the Redis state — every string assertion
# passed over it, and srh would never have gone healthy on ECS (#476).
#
# Needs docker. Without it the tests SKIP locally, and FAIL when
# SRH_HEALTHCHECK_REQUIRED=1 — which is how .github/workflows/terraform.yml
# runs it, so CI can never pass this by not running it.
#
# Every test ends with its decisive assertion (AGENTS.md: a `[[ ]]` or a
# negated pipeline in the middle of a @test does not fail it).

setup_file() {
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    return 0
  fi

  ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  MODULE="$ROOT/deploy/aws-terraform"

  # The default of `variable "srh_image"`, read out of variables.tf so this
  # suite always runs the image the module actually deploys.
  SRH_IMAGE="$(sed -n '/^variable "srh_image"/,/^}/s/^  default *= *"\(.*\)"$/\1/p' "$MODULE/variables.tf")"
  REDIS_IMAGE="redis:8-alpine"

  # Unique per run: two suites on one docker host must not share names.
  SUFFIX="$(basename "$BATS_FILE_TMPDIR" | tr -c 'a-zA-Z0-9\n' '-' | tr 'A-Z' 'a-z')-$$"
  NET="srhhc-net-$SUFFIX"
  REDIS="srhhc-redis-$SUFFIX"
  SRH="srhhc-srh-$SUFFIX"
  REDIS_PASSWORD="hc-redis-password-$$"
  TOKEN="hc-srh-token-$$"

  export SRH_IMAGE NET REDIS SRH TOKEN MODULE
  {
    echo "SRH_IMAGE=$SRH_IMAGE"
    echo "NET=$NET"
    echo "REDIS=$REDIS"
    echo "SRH=$SRH"
    echo "TOKEN=$TOKEN"
    echo "MODULE=$MODULE"
  } > "$BATS_FILE_TMPDIR/env"

  docker network create "$NET" >/dev/null
  docker run -d --name "$REDIS" --network "$NET" "$REDIS_IMAGE" \
    redis-server --requirepass "$REDIS_PASSWORD" >/dev/null
  docker run -d --name "$SRH" --network "$NET" \
    -e SRH_MODE=env \
    -e SRH_TOKEN="$TOKEN" \
    -e SRH_CONNECTION_STRING="redis://:$REDIS_PASSWORD@$REDIS:6379" \
    "$SRH_IMAGE" >/dev/null

  # srh (Elixir) takes a few seconds to listen. Wait for the check itself to
  # pass, bounded, so a genuinely broken probe fails the first test with a
  # timeout rather than hanging the suite.
  i=0
  while [ "$i" -lt 60 ]; do
    if docker exec -e SRH_TOKEN="$TOKEN" "$SRH" sh -c "$(cat "$MODULE/srh-healthcheck.sh")" >/dev/null 2>&1; then
      echo "ready" > "$BATS_FILE_TMPDIR/ready"
      break
    fi
    sleep 1
    i=$((i + 1))
  done
}

teardown_file() {
  if [ -f "$BATS_FILE_TMPDIR/env" ]; then
    # shellcheck disable=SC1091
    . "$BATS_FILE_TMPDIR/env"
    docker rm -f "$SRH" "$REDIS" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
  fi
}

setup() {
  if [ ! -f "$BATS_FILE_TMPDIR/env" ]; then
    if [ "${SRH_HEALTHCHECK_REQUIRED:-}" = "1" ]; then
      echo "FAIL: docker is not available, and SRH_HEALTHCHECK_REQUIRED=1 forbids skipping the srh health-check execution test." >&2
      return 1
    fi
    skip "docker is not available: the srh health check was NOT executed (CI sets SRH_HEALTHCHECK_REQUIRED=1, where this is a failure)"
  fi
  # shellcheck disable=SC1091
  . "$BATS_FILE_TMPDIR/env"
  CHECK="$(cat "$MODULE/srh-healthcheck.sh")"
}

# Runs the check exactly as ECS does: CMD-SHELL is `/bin/sh -c <command>` in
# the container, with SRH_TOKEN in its environment.
probe() {
  docker exec -e SRH_TOKEN="$1" "$SRH" sh -c "$CHECK"
}

@test "the image under test is the digest variables.tf pins" {
  echo "srh_image read from variables.tf: '$SRH_IMAGE'"
  echo "$SRH_IMAGE" | grep -q '^hiett/serverless-redis-http@sha256:[0-9a-f]\{64\}$'
}

@test "the right token against a live Redis passes" {
  # A missing marker FAILS the test rather than probing a half-up srh: a pass
  # here must mean srh came up and the check held, not that a late probe won.
  if [ ! -f "$BATS_FILE_TMPDIR/ready" ]; then
    echo "srh never passed its health check within 60s" >&2
    return 1
  fi
  run probe "$TOKEN"
  echo "status=$status output=$output"
  [ "$status" -eq 0 ]
}

@test "a wrong token fails" {
  # srh answers 401: the probe must not read that as healthy.
  run probe "not-the-token"
  echo "status=$status output=$output"
  [ "$status" -ne 0 ]
}

@test "a stopped Redis fails" {
  # Last, because it stops Redis for good: srh itself stays up and answers
  # 500, which is exactly the broken-data-path state a liveness probe misses.
  docker stop "$REDIS" >/dev/null
  run probe "$TOKEN"
  echo "status=$status output=$output"
  [ "$status" -ne 0 ]
}
