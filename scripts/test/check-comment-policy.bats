#!/usr/bin/env bats
#
# scripts/check-comment-policy.mjs (#505): the comment policy AGENTS.md
# states has to hold in the pre-v0.7.0 audit's top 20 files — no history, no
# change restatement, no issue/PR provenance; directive comments exempt; a
# shell heredoc's body belongs to the document being generated, not to the
# script. The first case runs the checker on the real repo; the rest copy
# AGENTS.md and the audited files into a scratch root, break one thing, and
# expect the checker to fail naming it. The decisive assertion is always the
# test's last statement.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/check-comment-policy.mjs"
  ROOT="$BATS_TEST_TMPDIR/root"
  mkdir -p "$ROOT"
  while IFS= read -r f; do
    mkdir -p "$ROOT/$(dirname "$f")"
    cp "$REPO_ROOT/$f" "$ROOT/$f"
  done < <(node "$SCRIPT" --list)
  cp "$REPO_ROOT/AGENTS.md" "$ROOT/AGENTS.md"
}

# Output contains a fixed string. A plain command, not a [[ ]] test, so a
# miss fails the test from any position under bats' errexit.
_has() {
  printf "%s\n" "$output" | grep -qF -- "$1"
}

# Appends a line to FILE (relative to ROOT).
_append() {
  printf '%s\n' "$2" >> "$ROOT/$1"
}

@test "the real repo passes the comment policy" {
  run node "$SCRIPT" "$REPO_ROOT"
  [ "$status" -eq 0 ]
}

@test "the unmodified copy passes (so every failure below is the mutation's)" {
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 0 ]
}

@test "a history comment in an audited file fails and names file:line" {
  _append "apps/web/src/lib/classic-store.ts" "// Previously the seed skipped the team rows entirely."
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has "apps/web/src/lib/classic-store.ts:"
  _has "history:"
}

@test "an issue/PR provenance ref fails" {
  _append "scripts/load-seed.mjs" "// Synthetic load, fixed by issue #439."
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has "scripts/load-seed.mjs:"
  _has "provenance:"
}

@test "a change restatement fails" {
  _append "apps/web/src/lib/team-store.ts" "// The reader now returns the stored count instead."
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has "apps/web/src/lib/team-store.ts:"
  _has "restatement:"
}

@test "an ADR or docs pointer beside an issue ref is not provenance" {
  _append "apps/web/src/lib/team-store.ts" "// Fails open on a transport blip (#464, ADR 59)."
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 0 ]
}

@test "directive comments are exempt" {
  _append "scripts/acceptance-ai-only.sh" "# shellcheck disable=SC2016"
  _append "apps/web/src/lib/metrics-store.ts" "// eslint-disable-next-line @typescript-eslint/no-explicit-any"
  _append "apps/web/src/lib/metrics-store.ts" "// @ts-expect-error testing the unchecked path"
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 0 ]
}

@test "a shell heredoc body is the generated document, not a comment" {
  # Appended as a whole: the `#` line sits between `cat <<'EOF'` and `EOF`.
  cat >> "$ROOT/setup/ctf-setup.sh" <<'OUTER'
render_manifest() {
  cat <<'EOF'
# previously this line is output of the generated document
EOF
}
OUTER
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 0 ]
}

@test "the policy missing from AGENTS.md fails and names AGENTS.md" {
  grep -vF -- '**Comments explain the present, not the past, and not the code.**' \
    "$ROOT/AGENTS.md" > "$ROOT/AGENTS.md.tmp"
  mv "$ROOT/AGENTS.md.tmp" "$ROOT/AGENTS.md"
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has "AGENTS.md: the comment policy is missing"
}

@test "an audited file that is gone fails rather than silently shrinking the scope" {
  rm "$ROOT/scripts/load-seed.mjs"
  run node "$SCRIPT" "$ROOT"
  [ "$status" -eq 1 ]
  _has "scripts/load-seed.mjs: listed as audited but not readable"
}
