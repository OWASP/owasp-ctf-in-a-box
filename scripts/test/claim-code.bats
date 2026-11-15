#!/usr/bin/env bats
# scripts/lib/claim-code.sh — the one helper every provisioning path (setup,
# dev-stack, Fly, AWS) generates and hashes admin claim codes with. The hash
# must match the app's (apps/web/src/lib/admin-claim.ts) byte for byte: both
# suites pin the same test vector.

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  LIB="$ROOT/scripts/lib/claim-code.sh"
  VECTOR_HASH=3eb1bd439947eb762998e566ccc2e099c791118b2f40579cc4f7da2b5061b7f9
}

@test "hash matches the app's test vector, whatever the case and separators" {
  . "$LIB"
  [ "$(claim_code_hash 0123-4567-89AB-cdef-0123-4567-89ab-cdef)" = "$VECTOR_HASH" ]
  [ "$(claim_code_hash ' 0123 4567 89ab cdef 0123 4567 89ab cdef ')" = "$VECTOR_HASH" ]
  [ "$(claim_code_hash 0123456789abcdef0123456789abcdef)" = "$VECTOR_HASH" ]
}

@test "hash refuses a code that does not normalize" {
  . "$LIB"
  run claim_code_hash 0123456789abcdef0123456789abcde
  [ "$status" -ne 0 ]
  [ -z "$output" ]
}

@test "new code has the grouped shape" {
  . "$LIB"
  run claim_code_new
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -qxE '([0-9a-f]{4}-){7}[0-9a-f]{4}'
}

@test "two new codes differ" {
  . "$LIB"
  a="$(claim_code_new)"
  b="$(claim_code_new)"
  [ -n "$a" ]
  [ "$a" != "$b" ]
}

@test "new code fails, naming openssl, when openssl is missing" {
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  printf '#!/bin/sh\nexit 1\n' > "$BATS_TEST_TMPDIR/bin/openssl"
  chmod +x "$BATS_TEST_TMPDIR/bin/openssl"
  run bash -c 'PATH="$1:$PATH"; . "$2"; claim_code_new' _ "$BATS_TEST_TMPDIR/bin" "$LIB"
  [ "$status" -eq 1 ]
  echo "$output" | grep -qF openssl
}

@test "normalize keeps 32 hex and refuses 31 or 33" {
  . "$LIB"
  [ "$(claim_code_normalize 0123-4567-89AB-CDEF-0123-4567-89ab-cdef)" = 0123456789abcdef0123456789abcdef ]
  run claim_code_normalize 0123456789abcdef0123456789abcde
  [ "$status" -eq 1 ]
  run claim_code_normalize 0123456789abcdef0123456789abcdef0
  [ "$status" -eq 1 ]
  run claim_code_normalize g123456789abcdef0123456789abcdef
  [ "$status" -eq 1 ]
}

@test "is_hash accepts 64 lowercase hex only" {
  . "$LIB"
  claim_code_is_hash "$VECTOR_HASH"
  run claim_code_is_hash 0123-4567-89ab-cdef-0123-4567-89ab-cdef
  [ "$status" -ne 0 ]
  run claim_code_is_hash "${VECTOR_HASH}0"
  [ "$status" -ne 0 ]
  run claim_code_is_hash ""
  [ "$status" -ne 0 ]
}

@test "announce prints the code once, where to claim it, and the recovery command" {
  . "$LIB"
  run claim_code_announce 0123-4567-89ab-cdef-0123-4567-89ab-cdef https://ctf.example.org './setup/ctf-setup.sh admin-code'
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | grep -cF 0123-4567-89ab-cdef-0123-4567-89ab-cdef)" -eq 1 ]
  echo "$output" | grep -qF 'https://ctf.example.org/admin/claim'
  echo "$output" | grep -qF 'It works once'
  echo "$output" | grep -qF './setup/ctf-setup.sh admin-code'
}
