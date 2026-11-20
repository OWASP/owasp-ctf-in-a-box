#!/usr/bin/env bats
#
# scripts/changelog-assemble.mjs: its node:test suite is run from here because
# CI runs `bats scripts/test/` and nothing runs `node --test` over this
# directory. The decisive assertion is the test's last statement.

@test "the changelog assembler's node:test suite passes" {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  run node --test "$REPO_ROOT/scripts/test/changelog-assemble.test.mjs"
  [ "$status" -eq 0 ]
}
