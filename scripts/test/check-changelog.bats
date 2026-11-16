#!/usr/bin/env bats
#
# scripts/check-changelog.sh (#483, #785): a change to shipped code must carry a
# changelog fragment. Each test builds a throwaway repo with a `base` commit,
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
  printf '# Changelog\n\n## Unreleased\n\n## v0.1.0\n\n- an old entry\n' > CHANGELOG.md
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

# Adds a changelog fragment, like a contributor would, and commits it with
# the other named files.
_entry() {
  mkdir -p changelog.d
  echo "- **Added: an entry (#$RANDOM).** prose." > "changelog.d/$RANDOM-entry.md"
  _commit "$@"
}

@test "code change without a fragment fails and names the path" {
  _commit sync/src/b.js
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "no changelog fragment added"
  _has "changelog.d/<issue>-<slug>.md"
  _has "no-changelog"
  _has "  sync/src/b.js"
}

@test "code change with a new fragment passes" {
  _entry apps/web/src/a.ts
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
@test "a rubric test change without a fragment fails — rubric tests are scoring inputs" {
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

@test "code plus tests without a fragment still fails, naming only the code" {
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

@test "deploy/ change without a fragment fails" {
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

# A CHANGELOG.md edit is the conflict source fragments replace: it never
# satisfies the check, whether under Unreleased or in an older release.
@test "a CHANGELOG.md edit under Unreleased does not count as an entry" {
  printf '# Changelog\n\n## Unreleased\n\n- an entry\n\n## v0.1.0\n\n- an old entry\n' > CHANGELOG.md
  _commit apps/web/src/a.ts CHANGELOG.md
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "no changelog fragment added"
}

@test "an edit only to an older release section does not count as an entry" {
  sed -i.bak 's/- an old entry/- an old entry, reworded/' CHANGELOG.md && rm -f CHANGELOG.md.bak
  _commit apps/web/src/a.ts CHANGELOG.md
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "changelog.d/"
}

@test "a new changelog.d/README.md alone does not count" {
  _commit apps/web/src/a.ts changelog.d/README.md
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "no changelog fragment added"
}

@test "a fragment in a subdirectory or without .md does not count" {
  _commit apps/web/src/a.ts changelog.d/sub/1-x.md changelog.d/2-y.txt
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
}

@test "an edited, not added, existing fragment does not count" {
  git switch -q main
  _commit changelog.d/1-x.md
  git tag -f base >/dev/null
  git switch -q feature
  git merge -q main
  _commit apps/web/src/a.ts changelog.d/1-x.md
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
}

@test "an empty or non-bullet fragment does not count" {
  mkdir -p changelog.d
  : > changelog.d/1-empty.md
  printf 'prose, not a bullet\n' > changelog.d/2-prose.md
  _commit apps/web/src/a.ts
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "empty or not a bullet entry"
  _has "  changelog.d/1-empty.md"
  _has "  changelog.d/2-prose.md"
}

@test "a bullet marker with nothing after it does not count" {
  mkdir -p changelog.d
  printf -- '- \n' > changelog.d/3-blank.md
  _commit apps/web/src/a.ts
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "  changelog.d/3-blank.md"
}

@test "an invalid fragment fails even beside a valid one" {
  mkdir -p changelog.d
  printf -- '- **Fixed: a thing (#1).** prose.\n' > changelog.d/1-good.md
  printf 'prose\n' > changelog.d/2-bad.md
  _commit apps/web/src/a.ts
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "  changelog.d/2-bad.md"
}

@test "an invalid fragment fails a PR that needs no entry" {
  mkdir -p changelog.d
  printf 'prose\n' > changelog.d/4-bad.md
  _commit docs/x.md
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "  changelog.d/4-bad.md"
}

@test "editing an existing fragment into invalid text fails" {
  mkdir -p changelog.d
  printf -- '- **Fixed: a thing (#5).** prose.\n' > changelog.d/5-old.md
  git add -A
  git commit -q -m "existing fragment"
  git tag -f base >/dev/null
  printf 'prose\n' > changelog.d/5-old.md
  _commit docs/x.md
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "  changelog.d/5-old.md"
}

@test "an edited valid fragment does not count as this PR's entry" {
  mkdir -p changelog.d
  printf -- '- **Fixed: a thing (#6).** prose.\n' > changelog.d/6-old.md
  git add -A
  git commit -q -m "existing fragment"
  git tag -f base >/dev/null
  printf -- '- **Fixed: a thing, reworded (#6).** prose.\n' > changelog.d/6-old.md
  _commit apps/web/src/a.ts
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "no changelog fragment added"
}

@test "a fragment alone, with no shipped code, passes" {
  mkdir -p changelog.d
  printf -- '- **Changed: docs (#9).** prose.\n' > changelog.d/9-x.md
  _commit docs/x.md
  run "$SCRIPT" base HEAD
  [ "$status" -eq 0 ]
}

# Review (#486): with rename detection, moving shipped code into docs/ would
# report only the docs/ destination and slip through.
@test "moving shipped code out of apps/ without an entry fails, naming the source" {
  mkdir -p docs/moved
  git mv apps/web/src/a.ts docs/moved/a.ts
  git commit -q -m "move"
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "  apps/web/src/a.ts"
}

# Review (#486): git quotes a non-ASCII path in --name-only output unless told
# not to, and a quoted path matched none of the shipped-code patterns.
@test "a shipped file with a non-ASCII name is still seen" {
  _commit "apps/web/src/café.ts"
  run "$SCRIPT" base HEAD
  [ "$status" -eq 1 ]
  _has "  apps/web/src/café.ts"
}

