#!/usr/bin/env bats
#
# `dev-stack score <player>` resolves a login through ctf:link:github:<login>
# and hands the scorer a player id, never a login. docker is stubbed on PATH:
# it answers the link-key GET, and records the player id the scorer exec was
# given. Each test ends with its decisive assertion.

ID="a11ce000-0000-4000-8000-000000000001"

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SANDBOX="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$SANDBOX/scripts/lib" "$BATS_TEST_TMPDIR/bin"
  cp "$REPO/scripts/dev-stack" "$SANDBOX/scripts/dev-stack"
  cp "$REPO/scripts/lib/dotenv.sh" "$SANDBOX/scripts/lib/dotenv.sh"
  printf 'SCORE_IMAGE=x\n' > "$SANDBOX/.env"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  : > "$CALLS"
  cat > "$BATS_TEST_TMPDIR/bin/docker" <<STUB
#!/bin/sh
echo "\$*" >> "\$CALLS"
case "\$*" in
  *"redis-cli GET ctf:link:github:alice-dev") echo "$ID" ;;
  *"redis-cli GET ctf:link:github:"*) : ;;
  *"scorer node -e"*) printf 202 ;;
esac
STUB
  chmod +x "$BATS_TEST_TMPDIR/bin/docker"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH"
}

@test "a linked login (any case) is scored under its player id" {
  run "$SANDBOX/scripts/dev-stack" score Alice-Dev juice-shop 2
  [ "$status" -eq 0 ]
  grep -q "CTF_PLAYER=$ID" "$CALLS"
  if grep -qF CTF_LOGIN "$CALLS"; then return 1; fi
  grep -qF 'ctf:link:github:alice-dev' "$CALLS"
}

@test "a player id is scored as given, with no link lookup" {
  run "$SANDBOX/scripts/dev-stack" score "$ID" dvwa 1
  [ "$status" -eq 0 ]
  if grep -qF 'ctf:link:github' "$CALLS"; then return 1; fi
  grep -q "CTF_PLAYER=$ID" "$CALLS"
}

@test "an unlinked login is refused by name and never reaches the scorer" {
  run "$SANDBOX/scripts/dev-stack" score nobody-dev dvwa 1
  [ "$status" -eq 1 ]
  [[ "$output" == *"no GitHub login 'nobody-dev' is linked"* ]]
  if grep -qF 'scorer node' "$CALLS"; then return 1; fi
}
