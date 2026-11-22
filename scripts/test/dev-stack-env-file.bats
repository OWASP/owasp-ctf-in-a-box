#!/usr/bin/env bats
#
# Which env file `dev-stack` runs on (#787). A real event's .env in the same
# checkout is never picked up on its own: the stack runs on the throwaway
# .env.dev-stack, or on the file --env-file names. And `up` refuses an
# EVENT_URL that is not loopback, because Caddy would ask Let's Encrypt for a
# certificate for that host from the developer's machine. docker is a stub
# that records its calls and fails `build`, so a run that gets past the env
# checks stops there instead of starting containers.

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
  unset ADMIN_CLAIM_CODE_HASH EVENT_URL GITHUB_ORG
}

_event_env() {
  printf 'REDIS_PASSWORD=x\nSCORE_IMAGE=\nEVENT_URL=%s\nGITHUB_ORG=event-org\nGITHUB_CLIENT_ID=event-client\n' "$2" > "$1"
}

@test "a real .env is left alone: up writes and uses the throwaway file" {
  _event_env "$SANDBOX/.env" https://ctf.example.org
  run "$SANDBOX/scripts/dev-stack" up
  [ -z "$(printf '%s\n' "$output" | grep -F 'using existing .env')" ]
  grep -qx 'EVENT_URL=http://localhost' "$SANDBOX/.env.dev-stack"
  grep -qx 'GITHUB_ORG=' "$SANDBOX/.env.dev-stack"
  grep -q '^build ' "$CALLS"
}

@test "an existing throwaway file is reused while a real .env sits next to it" {
  _event_env "$SANDBOX/.env" https://ctf.example.org
  _event_env "$SANDBOX/.env.dev-stack" http://localhost
  run "$SANDBOX/scripts/dev-stack" up
  printf '%s\n' "$output" | grep -qF 'using existing .env.dev-stack'
}

@test "--env-file with a public EVENT_URL is refused before any docker call" {
  _event_env "$SANDBOX/.env" https://ctf.example.org
  run "$SANDBOX/scripts/dev-stack" --env-file "$SANDBOX/.env" up
  [ "$status" -eq 1 ]
  [ ! -s "$CALLS" ]
  [ ! -e "$SANDBOX/.env.dev-stack" ]
  printf '%s\n' "$output" | grep -qF 'public certificate for ctf.example.org'
}

@test "a bare public host with a port is refused too" {
  _event_env "$SANDBOX/event.env" CTF.Example.org:8443
  run "$SANDBOX/scripts/dev-stack" --env-file "$SANDBOX/event.env" up
  [ "$status" -eq 1 ]
  [ ! -s "$CALLS" ]
  printf '%s\n' "$output" | grep -qF 'public certificate for ctf.example.org'
}

@test "an exported public EVENT_URL is refused before a throwaway file or claim code is made" {
  EVENT_URL=https://ctf.example.org run "$SANDBOX/scripts/dev-stack" up
  [ "$status" -eq 1 ]
  [ ! -s "$CALLS" ]
  [ -z "$(printf '%s\n' "$output" | grep -E '([0-9a-f]{4}-){7}[0-9a-f]{4}')" ]
  [ ! -e "$SANDBOX/.env.dev-stack" ]
}

@test "an exported public EVENT_URL wins over a loopback one in the file, as compose resolves it" {
  _event_env "$SANDBOX/.env.dev-stack" http://localhost
  EVENT_URL=https://ctf.example.org run "$SANDBOX/scripts/dev-stack" up
  [ "$status" -eq 1 ]
  [ ! -s "$CALLS" ]
  printf '%s\n' "$output" | grep -qF 'EVENT_URL exported in this shell'
}

@test "a public name that only starts with 127. is refused before any docker call" {
  local url
  for url in https://127.example.com http://127.0.0.1.nip.io:8080 http://127.256.0.1; do
    : > "$CALLS"
    _event_env "$SANDBOX/event.env" "$url"
    run "$SANDBOX/scripts/dev-stack" --env-file "$SANDBOX/event.env" up
    if [ "$status" -ne 1 ] || [ -s "$CALLS" ]; then
      echo "EVENT_URL='$url' was not refused: status $status, calls: $(cat "$CALLS")"
      return 1
    fi
  done
  printf '%s\n' "$output" | grep -qF 'public certificate for 127.256.0.1'
}

@test "follow-up commands name the --env-file the run used, quoted" {
  cd "$SANDBOX"
  # shellcheck disable=SC1091
  . scripts/dev-stack
  [ "$(dev_stack_cmd)" = ./scripts/dev-stack ]
  ENV_FILE_OPT="$BATS_TEST_TMPDIR/my events/event.env"
  eval "set -- $(dev_stack_cmd)"
  [ "$1" = ./scripts/dev-stack ]
  [ "$2" = --env-file ]
  [ "$3" = "$BATS_TEST_TMPDIR/my events/event.env" ]
}

@test "--env-file with a loopback EVENT_URL goes ahead" {
  local url
  for url in http://localhost:8080 http://ctf.localhost https://127.0.0.1/ http://127.10.0.2:8080 'http://[::1]:3000' ''; do
    : > "$CALLS"
    _event_env "$SANDBOX/event.env" "$url"
    run "$SANDBOX/scripts/dev-stack" --env-file "$SANDBOX/event.env" up
    if ! grep -q '^build ' "$CALLS"; then
      echo "EVENT_URL='$url' did not reach the build: $output"
      return 1
    fi
  done
  [ ! -e "$SANDBOX/.env.dev-stack" ]
}

@test "a relative --env-file is read from the caller's directory, not the repo root" {
  mkdir -p "$BATS_TEST_TMPDIR/elsewhere"
  _event_env "$BATS_TEST_TMPDIR/elsewhere/local.env" http://localhost
  cd "$BATS_TEST_TMPDIR/elsewhere"
  run "$SANDBOX/scripts/dev-stack" --env-file local.env up
  printf '%s\n' "$output" | grep -qF "using existing $BATS_TEST_TMPDIR/elsewhere/local.env"
}

@test "a --env-file that does not exist is refused, not written" {
  run "$SANDBOX/scripts/dev-stack" --env-file "$SANDBOX/missing.env" up
  [ "$status" -eq 2 ]
  [ ! -s "$CALLS" ]
  [ ! -e "$SANDBOX/missing.env" ]
  [ ! -e "$SANDBOX/.env.dev-stack" ]
}

@test "down uses the --env-file it is given" {
  _event_env "$SANDBOX/.env" https://ctf.example.org
  printf 'REDIS_PASSWORD=x\nSCORE_IMAGE=x\n' > "$SANDBOX/event.env"
  run "$SANDBOX/scripts/dev-stack" --env-file "$SANDBOX/event.env" down
  [ "$status" -eq 0 ]
  grep -qF -- "--env-file $SANDBOX/event.env" "$CALLS"
}

@test "score with only a real .env asks for up or --env-file instead of using it" {
  _event_env "$SANDBOX/.env" https://ctf.example.org
  run "$SANDBOX/scripts/dev-stack" score alice-dev juice-shop 1
  [ "$status" -eq 1 ]
  [ ! -s "$CALLS" ]
  printf '%s\n' "$output" | grep -qF 'no .env.dev-stack found'
}
