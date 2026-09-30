#!/usr/bin/env bats
#
# scripts/score-audit.mjs + scripts/score-audit.sh: CI runs `bats
# scripts/test/` and nothing runs `node --test` over this directory, so the
# auditor's node:test suite is run from here. The wrapper cases check that a
# bad argument is refused (exit 2) before anything reaches `fly` — the values
# end up in a remote `-C` command string. The decisive assertion is always
# the test's last statement.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  WRAPPER="$REPO_ROOT/scripts/score-audit.sh"
  # A `fly` that records any call, so "refused before fly" is asserted.
  STUB="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB"
  printf '#!/bin/sh\necho called >> "%s/fly.calls"\nexit 1\n' "$BATS_TEST_TMPDIR" > "$STUB/fly"
  chmod +x "$STUB/fly"
}

@test "the auditor's node:test suite passes" {
  run node --test "$REPO_ROOT/scripts/test/score-audit.test.mjs"
  [ "$status" -eq 0 ]
}

@test "--app is required" {
  run env PATH="$STUB:$PATH" "$WRAPPER"
  [ "$status" -eq 2 ]
}

@test "an --app with shell metacharacters is refused before fly runs" {
  run env PATH="$STUB:$PATH" "$WRAPPER" --app 'owasp-ctf;id'
  [ "$status" -eq 2 ] && [ ! -e "$BATS_TEST_TMPDIR/fly.calls" ]
}

@test "a --settle-ms that is not a plain number is refused before fly runs" {
  run env PATH="$STUB:$PATH" "$WRAPPER" --app owasp-ctf --settle-ms '1; rm -rf /'
  [ "$status" -eq 2 ] && [ ! -e "$BATS_TEST_TMPDIR/fly.calls" ]
}

@test "a --sd-cache-ms that is not a plain number is refused before fly runs" {
  run env PATH="$STUB:$PATH" "$WRAPPER" --app owasp-ctf --sd-cache-ms '5$(id)'
  [ "$status" -eq 2 ] && [ ! -e "$BATS_TEST_TMPDIR/fly.calls" ]
}

@test "an out-of-range --settle-ms is refused" {
  run env PATH="$STUB:$PATH" "$WRAPPER" --app owasp-ctf --settle-ms 999999
  [ "$status" -eq 2 ]
}

@test "a failing fly is a setup failure (exit 3), never a pass" {
  run env PATH="$STUB:$PATH" "$WRAPPER" --app owasp-ctf --report "$BATS_TEST_TMPDIR/r.json"
  [ "$status" -eq 3 ]
}
