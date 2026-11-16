#!/usr/bin/env bash
# check-changelog.sh — fail a change set that touches shipped code without a
# changelog fragment (#483, #785).
#
# Usage: scripts/check-changelog.sh <base-ref> <head-ref>
#
# Compares `git diff --no-renames --name-only -z BASE...HEAD` (three dots: what HEAD adds since
# it forked from BASE, so commits that landed on BASE afterwards are not
# blamed on the PR). Run by .github/workflows/changelog.yml with the PR's base
# and head SHAs; run it locally as `scripts/check-changelog.sh origin/main HEAD`.
#
# What needs an entry: any changed path under apps/, sync/, scorer/, setup/ or
# deploy/ — the trees that ship to an organizer's box — unless the diff also
# ADDS a fragment: a new `changelog.d/<name>.md` other than its README.md.
# Entries live in fragments, one file per PR, because every PR appending to
# the same `## Unreleased` block of CHANGELOG.md made every open PR conflict
# with every merge. scripts/changelog-assemble.mjs folds the fragments into
# CHANGELOG.md at release. An edit to CHANGELOG.md does NOT satisfy the check:
# it is the conflict source the fragments exist to avoid.
#
# What does NOT, by decision: test-only and doc-only paths inside those trees.
# A path counts as test-only when it sits under a `__tests__/`, `test/` or
# `tests/` directory, or its name matches `*.test.*`, `*.spec.*`, `*.bats` or
# `*.tftest.hcl`; doc-only when it ends in `.md`. A change made only of those
# alters nothing an organizer runs, and the issue names test-only changes as
# the case the `no-changelog` label exists for — exempting them here means
# nobody has to remember the label for the common one. A PR that mixes code
# with tests still needs the entry: the code path alone triggers it.
#
# Skip: CHANGELOG_SKIP=1 exits 0 without looking. The workflow sets it when
# the PR carries the `no-changelog` label or is opened by dependabot[bot].
#
# Fails closed: a ref git cannot resolve, or a diff git cannot compute, is an
# error (exit 2) naming what failed — never "no code changed".
#
# bash 3.2 compatible; no jq, no python.
set -euo pipefail

if [ "${CHANGELOG_SKIP:-0}" = "1" ]; then
  echo "check-changelog: skipped (CHANGELOG_SKIP=1 — no-changelog label or dependabot PR)"
  exit 0
fi

if [ "$#" -ne 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
  echo "check-changelog: usage: $0 <base-ref> <head-ref>" >&2
  echo "check-changelog: missing argument — got $# of 2" >&2
  exit 2
fi

base="$1"
head="$2"

for ref in "$base" "$head"; do
  if ! git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null; then
    echo "check-changelog: cannot resolve '${ref}' to a commit — fetch it (fetch-depth: 0 in CI) and retry" >&2
    exit 2
  fi
done

# NUL-delimited, unquoted and with no rename detection (#486 review):
# - `-z` plus core.quotePath=false, because git otherwise quotes a non-ASCII
#   or odd path, and a quoted path matched none of the patterns below;
# - `--no-renames`, because a detected rename reports only its destination,
#   so moving shipped code into docs/ would have passed as a docs change.
list="$(mktemp)"
added="$(mktemp)"
modified="$(mktemp)"
trap 'rm -f "$list" "$added" "$modified"' EXIT
if ! git -c core.quotePath=false diff --no-renames --name-only -z "${base}...${head}" > "$list"; then
  echo "check-changelog: git diff ${base}...${head} failed — no merge base? refusing to guess" >&2
  exit 2
fi
if ! git -c core.quotePath=false diff --no-renames --diff-filter=A --name-only -z "${base}...${head}" > "$added"; then
  echo "check-changelog: git diff ${base}...${head} failed — no merge base? refusing to guess" >&2
  exit 2
fi
if ! git -c core.quotePath=false diff --no-renames --diff-filter=M --name-only -z "${base}...${head}" > "$modified"; then
  echo "check-changelog: git diff ${base}...${head} failed — no merge base? refusing to guess" >&2
  exit 2
fi

# Returns 0 when a path is test-only or doc-only (see the header).
exempt() {
  local p="$1" name
  name="${p##*/}"
  # A rubric's tests/ files are not test code: the judge runs them against a
  # contestant's fork, so changing one moves scores. Only its docs are exempt.
  case "$p" in
    scorer/rubric*/*)
      case "$name" in *.md) return 0 ;; esac
      return 1
      ;;
  esac
  case "/$p" in
    */__tests__/* | */test/* | */tests/*) return 0 ;;
  esac
  case "$name" in
    *.test.* | *.spec.* | *.bats | *.tftest.hcl | *.md) return 0 ;;
  esac
  return 1
}

# A fragment is a file directly in changelog.d/ ending in .md, not the README.
# Every fragment the PR adds or edits must be one the release assembler
# accepts: its first non-blank line is a bullet with text after the "- ". One
# bad fragment fails the check even beside a good one, and even on a PR that
# needs no entry, because the assembler would stop on it at release. Only an
# ADDED valid fragment counts as this PR's entry.
fragment=""
invalid=""

# Prints "valid", "invalid" or "skip" for one changed path.
fragment_state() {
  local path="$1" first
  case "$path" in
    changelog.d/README.md | changelog.d/*/*) echo skip; return ;;
    changelog.d/*.md) ;;
    *) echo skip; return ;;
  esac
  first="$(git show "${head}:${path}" | grep -m1 -v '^[[:space:]]*$' || true)"
  case "$first" in
    "- "*[![:space:]]*) echo valid ;;
    *) echo invalid ;;
  esac
}

while IFS= read -r -d '' path; do
  case "$(fragment_state "$path")" in
    valid) fragment="$path" ;;
    invalid) invalid="${invalid}  ${path}
" ;;
  esac
done < "$added"

while IFS= read -r -d '' path; do
  if [ "$(fragment_state "$path")" = invalid ]; then
    invalid="${invalid}  ${path}
"
  fi
done < "$modified"

if [ -n "$invalid" ]; then
  {
    echo "check-changelog: these changelog fragments are empty or not a bullet entry:"
    printf '%s' "$invalid"
    echo "Fix: each changelog.d/<issue>-<slug>.md starts with a '- **Kind: summary (#N).** ...'"
    echo "bullet; see changelog.d/README.md."
  } >&2
  exit 1
fi

triggers=""
while IFS= read -r -d '' path; do
  [ -n "$path" ] || continue
  case "$path" in
    apps/* | sync/* | scorer/* | setup/* | deploy/*)
      if ! exempt "$path"; then
        triggers="${triggers}  ${path}
"
      fi
      ;;
  esac
done < "$list"

if [ -z "$triggers" ]; then
  echo "check-changelog: ok — no shipped code changed outside tests and docs"
  exit 0
fi

if [ -n "$fragment" ]; then
  echo "check-changelog: ok — code changed and the PR adds the fragment ${fragment}"
  exit 0
fi

{
  echo "check-changelog: no changelog fragment added, but this change touches shipped code:"
  printf '%s' "$triggers"
  echo "Fix: add a new file changelog.d/<issue>-<slug>.md (for example changelog.d/123-fix-login.md)"
  echo "holding the entry as a '- **Kind: summary (#N).** ...' bullet; see changelog.d/README.md."
  echo "Editing CHANGELOG.md does not count. For an internal change with nothing to tell an"
  echo "organizer (a pure refactor), ask a maintainer to apply the 'no-changelog' label."
} >&2
exit 1
