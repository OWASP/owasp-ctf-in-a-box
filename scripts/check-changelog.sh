#!/usr/bin/env bash
# check-changelog.sh — fail a change set that touches shipped code without a
# CHANGELOG.md entry (#483).
#
# Usage: scripts/check-changelog.sh <base-ref> <head-ref>
#
# Compares `git diff --name-only BASE...HEAD` (three dots: what HEAD adds since
# it forked from BASE, so commits that landed on BASE afterwards are not
# blamed on the PR). Run by .github/workflows/changelog.yml with the PR's base
# and head SHAs; run it locally as `scripts/check-changelog.sh origin/main HEAD`.
#
# What needs an entry: any changed path under apps/, sync/, scorer/, setup/ or
# deploy/ — the trees that ship to an organizer's box — unless the root
# CHANGELOG.md is also in the diff.
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

if ! changed="$(git diff --name-only "${base}...${head}")"; then
  echo "check-changelog: git diff ${base}...${head} failed — no merge base? refusing to guess" >&2
  exit 2
fi

# Returns 0 when a path is test-only or doc-only (see the header).
exempt() {
  local p="$1" name
  name="${p##*/}"
  case "/$p" in
    */__tests__/* | */test/* | */tests/*) return 0 ;;
  esac
  case "$name" in
    *.test.* | *.spec.* | *.bats | *.tftest.hcl | *.md) return 0 ;;
  esac
  return 1
}

has_changelog=0
triggers=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  if [ "$path" = "CHANGELOG.md" ]; then
    has_changelog=1
    continue
  fi
  case "$path" in
    apps/* | sync/* | scorer/* | setup/* | deploy/*)
      if ! exempt "$path"; then
        triggers="${triggers}  ${path}
"
      fi
      ;;
  esac
done <<EOF
$changed
EOF

if [ -z "$triggers" ]; then
  echo "check-changelog: ok — no shipped code changed outside tests and docs"
  exit 0
fi

if [ "$has_changelog" = "1" ]; then
  echo "check-changelog: ok — code changed and CHANGELOG.md is updated"
  exit 0
fi

{
  echo "check-changelog: CHANGELOG.md is not updated, but this change touches shipped code:"
  printf '%s' "$triggers"
  echo "Fix: add a line under '## Unreleased' in CHANGELOG.md describing the change,"
  echo "or, for an internal change with nothing to tell an organizer (a pure refactor),"
  echo "ask a maintainer to apply the 'no-changelog' label."
} >&2
exit 1
