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
if [ -n "\${FAIL_ON:-}" ]; then
  case "\$*" in
    *"\$FAIL_ON"*) echo "WRONGTYPE Operation against a key holding the wrong kind of value"; exit 1 ;;
  esac
fi
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
  if grep -qF 'scorer node' "$CALLS"; then return 1; fi
  printf '%s\n' "$output" | grep -qF "no GitHub login 'nobody-dev' is linked"
}

@test "seed_demo_accounts writes the auth row, email index and link keys, never overwriting a link" {
  export ENV_FILE=/dev/null
  cd "$SANDBOX"
  # shellcheck disable=SC1091
  . scripts/dev-stack
  run seed_demo_accounts
  [ "$status" -eq 0 ]
  grep -qF 'redis-cli -e HSETNX ctf:auth:user a11ce000-0000-4000-8000-000000000001 {"id":"a11ce000-0000-4000-8000-000000000001","name":"alice-dev","email":"alice-dev@dev-stack.invalid","emailVerified":true,"image":null,"createdAt":' "$CALLS"
  grep -qF 'redis-cli -e SADD ctf:auth:user:by:email:alice-dev@dev-stack.invalid a11ce000-0000-4000-8000-000000000001' "$CALLS"
  grep -qF 'redis-cli -e SETNX ctf:link:user:a11ce000-0000-4000-8000-000000000001 alice-dev' "$CALLS"
  if grep -qE 'redis-cli SET ctf:link' "$CALLS"; then return 1; fi
  grep -qF 'redis-cli -e SETNX ctf:link:github:mallory-dev ba11a000-0000-4000-8000-000000000004' "$CALLS"
}

@test "seed_demo_accounts fails on a redis error reply instead of reading it as seeded" {
  export ENV_FILE=/dev/null
  export FAIL_ON="redis-cli -e SADD ctf:auth:user:by:email:alice-dev"
  cd "$SANDBOX"
  # shellcheck disable=SC1091
  . scripts/dev-stack
  run seed_demo_accounts
  [ "$status" -eq 1 ]
  printf '%s\n' "$output" | grep -qF "could not write the demo account for 'alice-dev'"
}
