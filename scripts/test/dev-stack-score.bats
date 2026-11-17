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
  cp "$REPO/scripts/lib/dotenv.sh" "$REPO/scripts/lib/claim-code.sh" "$SANDBOX/scripts/lib/"
  printf 'SCORE_IMAGE=x\n' > "$SANDBOX/.env.dev-stack"
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

@test "seed_demo_accounts writes the auth row, email index, link keys and link time, never overwriting a link" {
  export ENV_FILE=/dev/null
  cd "$SANDBOX"
  # shellcheck disable=SC1091
  . scripts/dev-stack
  run seed_demo_accounts
  [ "$status" -eq 0 ]
  grep -qF 'redis-cli -e HSETNX ctf:auth:user a11ce000-0000-4000-8000-000000000001 {"id":"a11ce000-0000-4000-8000-000000000001","name":"alice-dev","email":"alice-dev@dev-stack.invalid","emailVerified":true,"image":null,"createdAt":' "$CALLS"
  grep -qF 'redis-cli -e SADD ctf:auth:user:by:email:alice-dev@dev-stack.invalid a11ce000-0000-4000-8000-000000000001' "$CALLS"
  grep -qF 'redis-cli -e SETNX ctf:link:user:a11ce000-0000-4000-8000-000000000001 alice-dev' "$CALLS"
  # A link with no time counts as made after the close, so a seeded link
  # without one would hold its scores forever once an end is set.
  grep -qE 'redis-cli -e HSETNX ctf:link:at a11ce000-0000-4000-8000-000000000001 [0-9]{13}$' "$CALLS"
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

# `up` on a box with no .env.dev-stack writes the throwaway one. It carries the hash of a
# fresh admin claim code (ADR 72) and never ADMIN_LOGINS; the code itself is
# printed once and not written. docker fails here, so `up` stops right after
# the file is written, before any container work.
@test "up writes a claim-code hash into its throwaway env and prints the code once" {
  rm -f "$SANDBOX/.env" "$SANDBOX/.env.dev-stack"
  printf '#!/bin/sh\nexit 1\n' > "$BATS_TEST_TMPDIR/bin/docker"
  run "$SANDBOX/scripts/dev-stack" up
  [ -f "$SANDBOX/.env.dev-stack" ]
  [ -z "$(grep -F ADMIN_LOGINS "$SANDBOX/.env.dev-stack")" ]
  code="$(printf '%s\n' "$output" | grep -oE '([0-9a-f]{4}-){7}[0-9a-f]{4}' | head -1)"
  [ -n "$code" ]
  [ "$(printf '%s\n' "$output" | grep -cF "$code")" -eq 1 ]
  [ -z "$(grep -F "$code" "$SANDBOX/.env.dev-stack")" ]
  grep -qE '^ADMIN_CLAIM_CODE_HASH=[0-9a-f]{64}$' "$SANDBOX/.env.dev-stack"
}
