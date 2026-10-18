#!/usr/bin/env bats
#
# The `coderabbit-approved` merge gate (#487). The shell that decides the
# verdict is the thing under test, so this harness extracts the step's `run:`
# block straight out of the workflow and executes it with a stub `gh` on PATH
# — there is no second copy of the logic to drift out of step with the one CI
# runs. The stub replays recorded review payloads through the SAME `--jq`
# filter the workflow passes, one page at a time, exactly as `gh api
# --paginate` does, so the filter that drops COMMENTED is exercised too.
#
# jq is required (it is what the stub filters with) and the CI shell job
# installs it, so a skip here would be a gate that proved nothing. Every test
# ends on its decisive `[ ... ]`/`run` status and prints what it saw.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  WF="$ROOT/.github/workflows/coderabbit-approved.yml"
  RUN="$BATS_TEST_TMPDIR/step.sh"
  STUB="$BATS_TEST_TMPDIR/bin"
  PAGES="$BATS_TEST_TMPDIR/pages"
  PAGELIST="$BATS_TEST_TMPDIR/pages.list"
  mkdir -p "$STUB" "$PAGES"

  if ! command -v jq >/dev/null; then
    echo "jq is required to replay the workflow's --jq filter"
    return 1
  fi

  # The `run:` block is the last key in the step, and the only one in the
  # file. Strip the block scalar's indentation so it runs as a plain script.
  awk '
    /^[[:space:]]*run: \|/ { inrun = 1; next }
    inrun {
      if ($0 ~ /^[[:space:]]*$/) { print ""; next }
      if (bi == 0) { match($0, /^[[:space:]]*/); bi = RLENGTH }
      match($0, /^[[:space:]]*/)
      if (RLENGTH < bi) exit
      print substr($0, bi + 1)
    }
  ' "$WF" > "$RUN"

  cat > "$STUB/gh" <<'STUB_GH'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" != "api" ]; then
  echo "stub gh: unexpected subcommand: ${1:-}" >&2
  exit 2
fi
shift
filter=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --paginate) shift ;;
    --jq) filter="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "${STUB_GH_FAIL:-}" ]; then
  echo "stub gh: simulated API failure" >&2
  exit 1
fi
# Replay each recorded page through the workflow's real --jq filter, in the
# order the API returned the pages.
while IFS= read -r page; do
  [ -n "$page" ] || continue
  jq -r "$filter" "$page"
done < "$STUB_GH_PAGES"
STUB_GH
  chmod +x "$STUB/gh"

  HEAD_SHA="1111111111111111111111111111111111111111"
  OTHER_SHA="2222222222222222222222222222222222222222"
}

# rev <state> <commit_id> <submitted_at> [login] — one review object.
rev() {
  printf '{"user":{"login":"%s"},"state":"%s","commit_id":"%s","submitted_at":"%s"}' \
    "${4:-coderabbitai[bot]}" "$1" "$2" "$3"
}

# page <json-review>... — a JSON array, one API page.
page() {
  out="["; sep=""
  for r in "$@"; do out="${out}${sep}${r}"; sep=","; done
  printf '%s' "${out}]"
}

# mkpage <name> <page-json> — record a page.
mkpage() { printf '%s' "$2" > "$PAGES/$1.json"; }

# gate <page-name>... — run the extracted step over these pages, in this
# order, with $PR_AUTHOR (default a plain user) and $STUB_GH_FAIL honoured.
gate() {
  : > "$PAGELIST"
  for p in "$@"; do printf '%s\n' "$PAGES/$p.json" >> "$PAGELIST"; done
  run env "PATH=$STUB:$PATH" REPO="example/repo" PR=7 HEAD_SHA="$HEAD_SHA" \
    PR_AUTHOR="${PR_AUTHOR:-octocat}" GH_TOKEN=x \
    STUB_GH_FAIL="${STUB_GH_FAIL:-}" STUB_GH_PAGES="$PAGELIST" bash "$RUN"
}

# The guard that keeps the rest honest: if the extractor ever stops matching
# the workflow, every case below would run an empty script and pass vacuously.
@test "the harness extracted the workflow's real run block" {
  grep -qF 'coderabbitai[bot]' "$RUN" || { echo "no CodeRabbit selector in the extracted block"; return 1; }
  grep -qF 'dependabot[bot]' "$RUN" || { echo "no Dependabot bypass in the extracted block"; return 1; }
  grep -qF 'APPROVED' "$RUN"
}

# --- The three regressions the fix is for -------------------------------

@test "APPROVED then a newer COMMENTED on the same head still passes" {
  mkpage p1 "$(page \
    "$(rev APPROVED "$HEAD_SHA" 2026-01-01T00:00:00Z)" \
    "$(rev COMMENTED "$HEAD_SHA" 2026-01-02T00:00:00Z)")"
  gate p1
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "a newer CHANGES_REQUESTED beats an earlier APPROVED on this head" {
  mkpage p1 "$(page \
    "$(rev APPROVED "$HEAD_SHA" 2026-01-01T00:00:00Z)" \
    "$(rev CHANGES_REQUESTED "$HEAD_SHA" 2026-01-02T00:00:00Z)")"
  gate p1
  echo "$output"
  [ "$status" -eq 1 ]
}

@test "a newer DISMISSED beats an earlier APPROVED on this head" {
  mkpage p1 "$(page \
    "$(rev APPROVED "$HEAD_SHA" 2026-01-01T00:00:00Z)" \
    "$(rev DISMISSED "$HEAD_SHA" 2026-01-02T00:00:00Z)")"
  gate p1
  echo "$output"
  [ "$status" -eq 1 ]
}

@test "Dependabot passes with no CodeRabbit review at all" {
  # No pages, and gh would fail if it were ever called: the bypass must
  # short-circuit before the API, not merely tolerate an empty result.
  PR_AUTHOR="dependabot[bot]" STUB_GH_FAIL=1 gate
  echo "$output"
  [ "$status" -eq 0 ]
}

# --- Retained coverage ---------------------------------------------------

@test "an APPROVED review on this head passes" {
  mkpage p1 "$(page "$(rev APPROVED "$HEAD_SHA" 2026-01-01T00:00:00Z)")"
  gate p1
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "a stale approval on another commit does not pass" {
  mkpage p1 "$(page "$(rev APPROVED "$OTHER_SHA" 2026-01-01T00:00:00Z)")"
  gate p1
  echo "$output"
  [ "$status" -eq 1 ]
}

@test "no review at all fails closed" {
  mkpage p1 "$(page)"
  gate p1
  echo "$output"
  [ "$status" -eq 1 ]
}

@test "a comment-only review is not a verdict and fails closed" {
  mkpage p1 "$(page "$(rev COMMENTED "$HEAD_SHA" 2026-01-01T00:00:00Z)")"
  gate p1
  echo "$output"
  [ "$status" -eq 1 ]
}

@test "an API failure fails closed" {
  mkpage p1 "$(page "$(rev APPROVED "$HEAD_SHA" 2026-01-01T00:00:00Z)")"
  STUB_GH_FAIL=1 gate p1
  echo "$output"
  [ "$status" -eq 1 ]
}

@test "the newest APPROVED wins even when it sits on the first page" {
  # Paginated newest-first: a naive first/last-row pick would read the older
  # CHANGES_REQUESTED and fail. Only ordering by submitted_at passes.
  mkpage p1 "$(page "$(rev APPROVED "$HEAD_SHA" 2026-01-02T00:00:00Z)")"
  mkpage p2 "$(page "$(rev CHANGES_REQUESTED "$HEAD_SHA" 2026-01-01T00:00:00Z)")"
  gate p1 p2
  echo "$output"
  [ "$status" -eq 0 ]
}

@test "a newer verdict on a later page still wins over an earlier approval" {
  mkpage p1 "$(page "$(rev APPROVED "$HEAD_SHA" 2026-01-01T00:00:00Z)")"
  mkpage p2 "$(page "$(rev CHANGES_REQUESTED "$HEAD_SHA" 2026-01-02T00:00:00Z)")"
  gate p1 p2
  echo "$output"
  [ "$status" -eq 1 ]
}

@test "a human author whose login merely contains the bot name is not bypassed" {
  # Exact match only: a login like `dependabot[bot]-suffix` is a real, but
  # different, actor and must go through the reviews API (and fail closed
  # here, since no verdict exists).
  mkpage p1 "$(page)"
  PR_AUTHOR="dependabot[bot]-impostor" gate p1
  echo "$output"
  [ "$status" -eq 1 ]
}
