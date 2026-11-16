#!/usr/bin/env bats
#
# `dev-stack up` and an exported ADMIN_CLAIM_CODE_HASH. Compose gives the
# shell environment precedence over --env-file (an exported empty value
# included), so a hash exported in the caller's shell is what the app gets,
# and the code announced for the env file's hash could not claim. `up` must
# refuse that before it generates a code or starts anything. docker is a stub
# that records its calls and fails `build`, so a run that gets past the env
# check stops right there instead of waiting on containers.

FILE_HASH=3eb1bd439947eb762998e566ccc2e099c791118b2f40579cc4f7da2b5061b7f9
OTHER_HASH=0000000000000000000000000000000000000000000000000000000000000000

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SANDBOX="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$SANDBOX/scripts/lib" "$BATS_TEST_TMPDIR/bin"
  cp "$REPO/scripts/dev-stack" "$SANDBOX/scripts/dev-stack"
  cp "$REPO/scripts/lib/dotenv.sh" "$REPO/scripts/lib/claim-code.sh" "$SANDBOX/scripts/lib/"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  : > "$CALLS"
  cat > "$BATS_TEST_TMPDIR/bin/docker" <<'STUB'
#!/bin/sh
echo "$*" >> "$CALLS"
case "$1" in build) exit 1 ;; esac
exit 0
STUB
  chmod +x "$BATS_TEST_TMPDIR/bin/docker"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH"
  unset ADMIN_CLAIM_CODE_HASH
}

_env_with_hash() {
  printf 'REDIS_PASSWORD=x\nSCORE_IMAGE=\nADMIN_CLAIM_CODE_HASH=%s\n' "$FILE_HASH" > "$SANDBOX/.env"
}

@test "an exported hash that differs from the env file's is refused before anything starts" {
  _env_with_hash
  ADMIN_CLAIM_CODE_HASH="$OTHER_HASH" run "$SANDBOX/scripts/dev-stack" up
  [ "$status" -eq 1 ]
  [ ! -s "$CALLS" ]
  [ -z "$(printf '%s\n' "$output" | grep -F "$OTHER_HASH")" ]
  printf '%s\n' "$output" | grep -qF 'ADMIN_CLAIM_CODE_HASH is exported'
}

@test "an exported EMPTY hash is refused too: compose would hand the app the empty value" {
  _env_with_hash
  ADMIN_CLAIM_CODE_HASH="" run "$SANDBOX/scripts/dev-stack" up
  [ "$status" -eq 1 ]
  [ ! -s "$CALLS" ]
  printf '%s\n' "$output" | grep -qF 'ADMIN_CLAIM_CODE_HASH is exported'
}

@test "with no env file, an exported hash is refused before a code is generated or a file written" {
  ADMIN_CLAIM_CODE_HASH="$OTHER_HASH" run "$SANDBOX/scripts/dev-stack" up
  [ "$status" -eq 1 ]
  [ ! -e "$SANDBOX/.env.dev-stack" ]
  [ -z "$(printf '%s\n' "$output" | grep -E '([0-9a-f]{4}-){7}[0-9a-f]{4}')" ]
  [ ! -s "$CALLS" ]
}

@test "an exported hash equal to the env file's goes ahead" {
  _env_with_hash
  ADMIN_CLAIM_CODE_HASH="$FILE_HASH" run "$SANDBOX/scripts/dev-stack" up
  [ -z "$(printf '%s\n' "$output" | grep -F 'ADMIN_CLAIM_CODE_HASH is exported')" ]
  grep -q '^build ' "$CALLS"
}
