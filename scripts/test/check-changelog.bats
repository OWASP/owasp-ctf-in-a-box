#!/usr/bin/env bats
#
# scripts/check-changelog.sh (#483): a change to shipped code must carry a
# CHANGELOG.md entry. Each test builds a throwaway repo with a `base` commit,
# branches, commits the case under test, and runs the script on base...HEAD.
# The decisive assertion is always the test's last statement.

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../check-changelog.sh"
  REPO="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$REPO"
  cd "$REPO"
  git init -q -b main .
  git config user.name "bats"
  git config user.email "bats@example.invalid"
  git config commit.gpgsign false
  mkdir -p apps/web/src sync/src scorer/src setup deploy/fly docs
  echo "# Changelog" > CHANGELOG.md
  echo "a" > apps/web/src/a.ts
  echo "b" > sync/src/b.js
  echo "c" > deploy/fly/fly.toml
  echo "d" > docs/index.md
  git add -A
  git commit -q -m "base"
  git tag base
  git switch -q -c feature
  unset CHANGELOG_SKIP
}

# Output contains a fixed string. A plain command, not a [[ ]] test, so a
# miss fails the test from any position under bats' errexit.
_has() {
  printf "%s\n" "$output" | grep -qF -- "$1"
}

# Writes (or appends to) each named file and commits them.
_commit() {
  local f
  for f in "$@"; do
    mkdir -p "$(dirname "$f")"
    echo "change $RANDOM" >> "$f"
  done
  git add -A
  git commit -q -m "change"
}

@test "code change without a CHANGELOG entry fails and names the path" {
  _commit sync/src/b.js
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "CHANGELOG.md is not updated"
  _has "no-changelog"
  _has "  sync/src/b.js"
}

@test "code change with a CHANGELOG entry passes" {
  _commit apps/web/src/a.ts CHANGELOG.md
  run "$SCRIPT" base HEAD
  [ "$status" -eq 0 ]
}

@test "docs-only change passes" {
  _commit docs/index.md README.md scorer/README.md
  run "$SCRIPT" base HEAD
  [ "$status" -eq 0 ]
}

@test "test-only change inside the code trees passes" {
  _commit apps/web/src/lib/__tests__/a.test.ts sync/test/b.test.js \
    scorer/test/fixtures/x.json setup/test/ctf_setup.bats \
    deploy/aws-terraform/stack.tftest.hcl
  run "$SCRIPT" base HEAD
  [ "$status" -eq 0 ]
}

# Review (#486): a rubric's tests/ directory is not test code — the judge
# runs those files against a contestant's fork, so changing one moves scores.
@test "a rubric test change without a CHANGELOG entry fails — rubric tests are scoring inputs" {
  _commit scorer/rubric.owasp/vampi/tests/challenge-3-sqli.test.js
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "  scorer/rubric.owasp/vampi/tests/challenge-3-sqli.test.js"
}

@test "a rubric README change still counts as docs" {
  _commit scorer/rubric.owasp/vampi/README.md
  run "$SCRIPT" base HEAD
  [ "$status" -eq 0 ]
}

@test "code plus tests without a CHANGELOG entry still fails, naming only the code" {
  _commit scorer/src/judge.js scorer/test/judge.test.js
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "  scorer/src/judge.js"
  [ -z "$(printf "%s\n" "$output" | grep -F -- "judge.test.js")" ]
}

@test "CHANGELOG_SKIP=1 passes a code change without an entry" {
  _commit setup/ctf-setup.sh
  CHANGELOG_SKIP=1 run "$SCRIPT" base HEAD
  [ "$status" -eq 0 ]
  _has "skipped"
}

@test "deploy/ change without a CHANGELOG entry fails" {
  _commit deploy/fly/fly.toml
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "  deploy/fly/fly.toml"
}

@test "a nested CHANGELOG.md does not count as the root one" {
  _commit apps/web/src/a.ts apps/web/CHANGELOG.md
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
}

@test "only commits since the merge base are blamed on the branch" {
  # main moves on with an unlogged code change after the branch point; the
  # branch itself only touches docs, so base...HEAD must not see main's commit.
  git switch -q main
  _commit apps/web/src/a.ts
  git switch -q feature
  _commit docs/index.md
  run "$SCRIPT" main HEAD
  [ "$status" -eq 0 ]
}

@test "an unresolvable ref fails closed and names it" {
  run "$SCRIPT" no-such-ref HEAD
  [ "$status" -eq 2 ]
  _has "cannot resolve 'no-such-ref'"
}

@test "a missing argument fails closed" {
  run "$SCRIPT" base
  [ "$status" -eq 2 ]
  _has "missing argument"
}
