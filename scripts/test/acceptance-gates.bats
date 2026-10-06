#!/usr/bin/env bats
#
# M15 (#504): the acceptance gates share scripts/lib/acceptance-lib.sh instead
# of hand-rolling it — acceptance-target.sh for the scoring path (source the
# lib, drop its own URL table/scorer build/staging/event/judge/score-parse),
# and the quiz/classic/ai *-only gates for their shared compose line-up,
# redis/srh + app bring-up, sync-refusal and leaderboard half.
#
# Content assertions on the scripts themselves (the check-changelog.bats
# house pattern): no docker, no network, no compose. The decisive check is
# always the test's last statement — a mid-test conditional would not gate
# pass/fail (AGENTS.md), and a bare grep would die silently (#257).

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  LIB="$ROOT/scripts/lib/acceptance-lib.sh"
  TARGET="$ROOT/scripts/acceptance-target.sh"
  QUIZ="$ROOT/scripts/acceptance-quiz-only.sh"
  CLASSIC="$ROOT/scripts/acceptance-classic-only.sh"
  AI="$ROOT/scripts/acceptance-ai-only.sh"
}

# Every test below: print exactly what is missing (or still present), then end
# on a single [ ... ] whose status gates the result.

# _need <file> <fixed-string> — append to $missing instead of failing, so one
# test can report EVERY absent call; the test's final [ -z "$missing" ] gates.
_need() {
  if ! grep -qF -- "$2" "$1"; then
    missing="$missing |${1##*/}:$2"
  fi
}

@test "acceptance-target.sh sources the shared acceptance-lib" {
  if ! grep -qF -- '. scripts/lib/acceptance-lib.sh' "$TARGET"; then
    echo "MISSING: acceptance-target.sh does not source scripts/lib/acceptance-lib.sh"
  fi
  grep -qF -- '. scripts/lib/acceptance-lib.sh' "$TARGET"
}

@test "acceptance-target.sh delegates build, URL table, staging, event, judge and score parse to the lib" {
  missing=""
  for tok in \
    'acc_build_scorer "$IMG"' \
    'acc_url_for "$TARGET"' \
    'acc_stage_source "$WS"' \
    'acc_write_event "$TMP/event.json"' \
    'acc_run_judge' \
    'acc_score_counts "$REPORT"'
  do
    if ! grep -qF -- "$tok" "$TARGET"; then
      missing="$missing |$tok"
    fi
  done
  if [ -n "$missing" ]; then
    echo "MISSING from acceptance-target.sh:$missing"
  fi
  [ -z "$missing" ]
}

@test "acceptance-target.sh no longer hand-rolls what the lib now provides" {
  stale=""
  for tok in \
    'APP_URL_SUFFIX=":5000"' \
    'case "$TARGET" in' \
    'docker build -q -t "$IMG" scorer/' \
    '{"pull_request":{"user":{"login":"stock-check"}' \
    '--entrypoint /usr/local/bin/entrypoint.sh' \
    'challenges patched'
  do
    if grep -qF -- "$tok" "$TARGET"; then
      stale="$stale |$tok"
    fi
  done
  if [ -n "$stale" ]; then
    echo "STILL HAND-ROLLED in acceptance-target.sh (M15 dedup did not happen):$stale"
  fi
  [ -z "$stale" ]
}

@test "the lib defines every shared *-only gate helper" {
  missing=""
  for tok in \
    'acc_compose_services()' \
    'acc_assert_module_lineups()' \
    'acc_boot_redis_srh()' \
    'acc_boot_app()' \
    'acc_write_sync_override()' \
    'acc_sync_compose()' \
    'acc_assert_sync_refuses_no_org()' \
    'acc_assert_leaderboard_contrib()'
  do
    if ! grep -qF -- "$tok" "$LIB"; then
      missing="$missing |$tok"
    fi
  done
  if [ -n "$missing" ]; then
    echo "MISSING from scripts/lib/acceptance-lib.sh:$missing"
  fi
  [ -z "$missing" ]
}

@test "each *-only gate calls the shared helpers with its own label/prefix" {
  missing=""
  _need "$QUIZ" 'acc_assert_module_lineups quiz'
  _need "$CLASSIC" 'acc_assert_module_lineups classic'
  _need "$AI" 'acc_assert_module_lineups ai'
  _need "$QUIZ" 'acc_boot_redis_srh "$NET" qo'
  _need "$CLASSIC" 'acc_boot_redis_srh "$NET" co'
  _need "$AI" 'acc_boot_redis_srh "$NET" ao'
  _need "$QUIZ" 'acc_boot_app qo-app'
  _need "$CLASSIC" 'acc_boot_app co-app'
  _need "$AI" 'acc_boot_app ao-app'
  _need "$QUIZ" 'acc_write_sync_override "$SYNC_OVERRIDE"'
  _need "$CLASSIC" 'acc_write_sync_override "$SYNC_OVERRIDE"'
  _need "$AI" 'acc_write_sync_override "$SYNC_OVERRIDE"'
  _need "$QUIZ" 'acc_assert_sync_refuses_no_org "$SYNC_PROJECT" "$SYNC_OVERRIDE"'
  _need "$CLASSIC" 'acc_assert_sync_refuses_no_org "$SYNC_PROJECT" "$SYNC_OVERRIDE"'
  _need "$AI" 'acc_assert_sync_refuses_no_org "$SYNC_PROJECT" "$SYNC_OVERRIDE"'
  _need "$QUIZ" 'acc_assert_leaderboard_contrib "$APP_URL" quiz'
  _need "$CLASSIC" 'acc_assert_leaderboard_contrib "$APP_URL" classic'
  _need "$AI" 'acc_assert_leaderboard_contrib "$APP_URL" ai'
  _need "$QUIZ" 'acc_sync_compose "$SYNC_PROJECT" "$SYNC_OVERRIDE" down'
  _need "$CLASSIC" 'acc_sync_compose "$SYNC_PROJECT" "$SYNC_OVERRIDE" down'
  _need "$AI" 'acc_sync_compose "$SYNC_PROJECT" "$SYNC_OVERRIDE" down'
  if [ -n "$missing" ]; then
    echo "MISSING from a *-only gate:$missing"
  fi
  [ -z "$missing" ]
}

@test "no *-only gate still defines the machinery the lib now provides" {
  stale=""
  for f in "$QUIZ" "$CLASSIC" "$AI"; do
    for name in compose_services sync_compose; do
      # Anchored at column 1: `acc_sync_compose()` must not match `sync_compose()`.
      if grep -q "^$name()" "$f"; then
        stale="$stale |${f##*/}:$name()"
      fi
    done
  done
  if [ -n "$stale" ]; then
    echo "STILL DEFINED (M15 dedup did not happen):$stale"
  fi
  [ -z "$stale" ]
}
