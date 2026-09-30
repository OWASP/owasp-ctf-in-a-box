#!/usr/bin/env bats
#
# scripts/load-seed.mjs: its node:test suite (load-seed.test.mjs) is run from
# here because CI runs `bats scripts/test/` and nothing runs `node --test`
# over this directory — the suite existed for a while without CI ever
# executing it. The decisive assertion is the test's last statement.

@test "the load seeder's node:test suite passes" {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  run node --test "$REPO_ROOT/scripts/test/load-seed.test.mjs"
  [ "$status" -eq 0 ]
}
