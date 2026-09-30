#!/usr/bin/env bats
#
# scripts/check-docs-drift.mjs (#501): the ADR index in docs/decisions.md and
# the local copies of CI's shell commands (Makefile, AGENTS.md,
# CONTRIBUTING.md) and the .nvmrc Node pin must not drift. The first case runs the checker on the real
# repo; the rest copy the files it reads into a scratch root, break one
# thing, and expect the checker to fail naming it. The decisive assertion is
# always the test's last statement.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/check-docs-drift.mjs"
  ROOT="$BATS_TEST_TMPDIR/root"
  mkdir -p "$ROOT/docs" "$ROOT/.github/workflows"
  cp "$REPO_ROOT/docs/decisions.md" "$ROOT/docs/decisions.md"
  cp "$REPO_ROOT/.github/workflows/ci.yml" "$ROOT/.github/workflows/ci.yml"
  cp "$REPO_ROOT/Makefile" "$REPO_ROOT/AGENTS.md" "$REPO_ROOT/CONTRIBUTING.md" "$REPO_ROOT/.nvmrc" "$ROOT/"
}

# Output contains a fixed string. A plain command, not a [[ ]] test, so a
# miss fails the test from any position under bats' errexit.
_has() {
  printf "%s\n" "$output" | grep -qF -- "$1"
}

# Drops every line of FILE (relative to ROOT) that contains the fixed string.
_drop() {
  grep -vF -- "$2" "$ROOT/$1" > "$ROOT/$1.tmp"
  mv "$ROOT/$1.tmp" "$ROOT/$1"
}

# Replaces a fixed string in FILE (relative to ROOT), first match per line.
# The replacement goes through awk -v, so a \n escape in it becomes a newline.
_swap() {
  awk -v a="$2" -v b="$3" '{ i = index($0, a); if (i) $0 = substr($0, 1, i - 1) b substr($0, i + length(a)); print }' \
    "$ROOT/$1" > "$ROOT/$1.tmp"
  mv "$ROOT/$1.tmp" "$ROOT/$1"
}

@test "the real repo has no docs drift" {
  run node "$SCRIPT" "$REPO_ROOT"
  [ "$status" -eq 0 ]
}

@test "the unmodified copy passes (so every failure below is the mutation's)" {
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 0 ]
}

@test "an ADR heading with no index entry fails and names the ADR" {
  _drop docs/decisions.md "- [ADR 54 — "
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has "ADR 54 has no entry in the index"
}

@test "an index entry whose anchor does not match the heading fails" {
  _swap docs/decisions.md "(#adr-58-demo-seedclear-" "(#adr-58-demo-seed-clear-"
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has "the ADR 58 index entry points at #adr-58-demo-seed-clear-"
}

@test "an index entry with no ADR heading fails" {
  _swap docs/decisions.md "- [ADR 53 — " "- [ADR 999 — "
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has "the index lists ADR 999, which has no"
}

@test "a heading that wraps onto a second line fails" {
  _swap docs/decisions.md "## ADR 57. Sponsors are recognition-only, appear in four fixed surfaces, and the disclaimer is not configurable" \
    "## ADR 57. Sponsors are recognition-only, appear in four fixed surfaces, and\\nthe disclaimer is not configurable"
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  # The wrap truncates the heading's anchor, so the index entry no longer
  # matches it: that comparison is the detector (#512 review).
  _has "the ADR 57 index entry points at #adr-57-sponsors-are-recognition-only-appear-in-four-fixed-surfaces-and-the-disclaimer-is-not-configurable, but the heading's anchor is #adr-57-sponsors-are-recognition-only-appear-in-four-fixed-surfaces-and"
}

# #512 review: in Markdown an ATX heading is always one line, so a paragraph
# right under a valid heading (no blank line between) is fine and must pass.
@test "a paragraph directly under a valid one-line heading passes" {
  _swap docs/decisions.md "## ADR 57. Sponsors are recognition-only, appear in four fixed surfaces, and the disclaimer is not configurable" \
    "## ADR 57. Sponsors are recognition-only, appear in four fixed surfaces, and the disclaimer is not configurable\nA paragraph that starts right under the heading."
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 0 ]
}

@test "an in-page ADR link that lands on no heading fails" {
  _swap docs/decisions.md "**Context.** Issue #474. [ADR 57](#adr-57-sponsors-are-recognition-only-appear-in-four-fixed-surfaces-and-the-disclaimer-is-not-configurable)" \
    "**Context.** Issue #474. [ADR 57](#adr-57-sponsors-are-recognition-only-appear-in-four-fixed-surfaces-and)"
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has "link to #adr-57-sponsors-are-recognition-only-appear-in-four-fixed-surfaces-and, which no ADR heading generates"
}

@test "a bats suite CI runs that the Makefile omits fails and names the Makefile" {
  _swap Makefile " && bats deploy/aws-terraform/test/" ""
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has 'Makefile: CI'\''s shell job runs `deploy/aws-terraform/test/`'
}

@test "a new path in CI's shellcheck run fails for all three local copies" {
  _swap .github/workflows/ci.yml "deploy/aws-terraform/deploy.sh" "deploy/aws-terraform/deploy.sh deploy/new/thing.sh"
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has 'Makefile: CI'\''s shell job runs `deploy/new/thing.sh`'
  _has 'AGENTS.md: CI'\''s shell job runs `deploy/new/thing.sh`'
  _has 'CONTRIBUTING.md: CI'\''s shell job runs `deploy/new/thing.sh`'
}

# #512 review: a named step puts `run:` on its own line with no `- ` marker.
# The parser used to match only `- run:`, so a path added that way slipped by.
@test "a shell path in a named step (run: without the - marker) is still checked" {
  _swap .github/workflows/ci.yml "      - run: bats scripts/test/" "      - name: a named step\n        run: bats deploy/new/named/\n      - run: bats scripts/test/"
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has 'Makefile: CI'\''s shell job runs `deploy/new/named/`'
}

# #512 review: a block-scalar step (`run: |` and the commands under it) is a
# command too; a suite added there must still be mirrored locally.
@test "a shell path in a block-scalar run step is still checked" {
  _swap .github/workflows/ci.yml "      - run: bats scripts/test/" "      - name: a block step\n        run: |\n          echo first\n          bats deploy/new/block/\n      - run: bats scripts/test/"
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has 'Makefile: CI'\''s shell job runs `deploy/new/block/`'
}

# #512 review: a path the docs only mention in prose is not a command anyone
# will run. Only fenced code blocks (Markdown) and recipe lines (Makefile)
# count, so dropping the command but keeping a prose mention must fail.
@test "a path kept only in prose, with its command dropped, fails" {
  _drop AGENTS.md "bats deploy/aws-terraform/test/"
  printf '\nThe AWS suite lives in deploy/aws-terraform/test/ and runs in CI.\n' >> "$ROOT/AGENTS.md"
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has 'AGENTS.md: CI'\''s shell job runs `deploy/aws-terraform/test/`'
}

# #512 review: a `\` continuation carries more paths on the next line; they
# belong to the same command and must be checked too.
@test "a shell path on a backslash continuation line is still checked" {
  # Real lines, not an escaped string: the continuation must survive intact.
  block="$BATS_TEST_TMPDIR/block.yml"
  printf '%s\n' '      - name: a continued step' '        run: |' '          bats scripts/test/ \' '            deploy/new/continued/' > "$block"
  awk -v f="$block" '/^      - run: bats scripts\/test\/$/ { while ((getline l < f) > 0) print l } { print }' \
    "$ROOT/.github/workflows/ci.yml" > "$ROOT/ci.tmp"
  mv "$ROOT/ci.tmp" "$ROOT/.github/workflows/ci.yml"
  grep -qx '          bats scripts/test/ \\' "$ROOT/.github/workflows/ci.yml"
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has 'Makefile: CI'\''s shell job runs `deploy/new/continued/`'
}

@test "a workflow node-version that differs from .nvmrc fails" {
  printf '24\n' > "$ROOT/.nvmrc"
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has ".github/workflows/ci.yml:"
  _has "node-version 22, but .nvmrc pins 24"
}

@test "a missing .nvmrc fails" {
  rm "$ROOT/.nvmrc"
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has ".nvmrc: missing"
}
