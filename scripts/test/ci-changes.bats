#!/usr/bin/env bats
#
# scripts/ci-changes.sh — the `changes` job's path filter. Each case writes a
# changed-file list and asserts the areas the script reports for it. The
# decisive check is always the test's last statement (AGENTS.md), and every
# failure prints the output it got.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  SCRIPT="$ROOT/scripts/ci-changes.sh"
  CI_YML="$ROOT/.github/workflows/ci.yml"
  LIST="$BATS_TEST_TMPDIR/changed.txt"
}

# areas <path>... — run the script on these paths; output in $output.
areas() {
  printf '%s\n' "$@" > "$LIST"
  run "$SCRIPT" "$LIST"
}

@test "a list far past the 64 KiB pipe buffer still matches (no SIGPIPE false)" {
  # The matching path comes FIRST, so a pipe-fed `grep -q` would exit on line
  # one while the writer still had ~200 KiB to send.
  {
    echo "apps/web/src/app/page.tsx"
    i=0
    while [ "$i" -lt 4000 ]; do
      echo "docs/generated/a-long-path-segment-to-fill-the-buffer-quickly/file-$i.md"
      i=$((i + 1))
    done
  } > "$LIST"
  size="$(wc -c < "$LIST" | tr -d ' ')"
  [ "$size" -gt 65536 ] || { echo "fixture too small to prove anything: $size bytes"; return 1; }
  run "$SCRIPT" "$LIST"
  echo "$output"
  [ "$status" -eq 0 ]
  grep -qx 'app=true' <<< "$output"
}

@test "a Caddyfile edit runs app (header pin + caddy validate), not smoke" {
  areas caddy/Caddyfile.poll
  echo "$output"
  grep -qx 'smoke=false' <<< "$output" || { echo "smoke ran for a caddy-only edit"; return 1; }
  grep -qx 'app=true' <<< "$output"
}

@test "nothing matches a root Caddyfile any more (the file does not exist)" {
  areas Caddyfile
  echo "$output"
  [ -z "$(grep -x '[a-z]*=true' <<< "$output")" ]
}

@test "a vendored rubric catalogue edit runs app (apps-catalogue.test.ts)" {
  areas scorer/rubric.owasp/vampi/tests/challenges/catalogue.vampi.json
  echo "$output"
  grep -qx 'scorer=true' <<< "$output" || { echo "scorer did not run"; return 1; }
  grep -qx 'app=true' <<< "$output"
}

@test "the secure-dev-targets corpus runs both of its readers" {
  areas test/fixtures/secure-dev-targets-corpus.json
  echo "$output"
  grep -qx 'sync=true' <<< "$output" || { echo "sync did not run"; return 1; }
  grep -qx 'app=true' <<< "$output"
}

@test "sync/docker-entrypoint.sh runs shell (it is shellcheck'd there)" {
  areas sync/docker-entrypoint.sh
  echo "$output"
  grep -qx 'shell=true' <<< "$output"
}

@test "editing the filter itself runs every area" {
  areas scripts/ci-changes.sh
  echo "$output"
  [ -z "$(grep -x '[a-z]*=false' <<< "$output")" ]
}

@test "an unrelated path runs nothing" {
  areas README.md
  echo "$output"
  [ "$status" -eq 0 ]
  [ -z "$(grep -x '[a-z]*=true' <<< "$output")" ]
}

@test "a missing list fails closed: exit 2, no area reported" {
  run "$SCRIPT" "$BATS_TEST_TMPDIR/does-not-exist"
  echo "$output"
  [ "$status" -eq 2 ]
  [ -z "$(grep '=' <<< "$output")" ]
}

@test "no argument fails closed" {
  run "$SCRIPT"
  echo "$output"
  [ "$status" -eq 2 ]
}

@test "PR mode, --all and ci.yml's changes outputs name the same areas" {
  areas README.md
  pr="$(sed 's/=.*//' <<< "$output" | sort | tr '\n' ' ')"
  run "$SCRIPT" --all
  all="$(sed 's/=.*//' <<< "$output" | sort | tr '\n' ' ')"
  wired="$(sed -n 's/^      \([a-z]*\): \${{ steps\.f\.outputs\.\([a-z]*\) }}$/\1/p' "$CI_YML" | sort | tr '\n' ' ')"
  echo "pr:    $pr"
  echo "all:   $all"
  echo "wired: $wired"
  [ -n "$pr" ] && [ "$pr" = "$all" ] && [ "$all" = "$wired" ]
}

@test "--all reports every area true" {
  run "$SCRIPT" --all
  echo "$output"
  [ "$status" -eq 0 ]
  [ -z "$(grep -x '[a-z]*=false' <<< "$output")" ]
}

@test "docker-compose.smoke.yml runs shell (pins.bats checks its image: lines)" {
  areas docker-compose.smoke.yml
  echo "$output"
  grep -qx 'shell=true' <<< "$output"
}
