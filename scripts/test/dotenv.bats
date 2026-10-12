#!/usr/bin/env bats
#
# scripts/lib/dotenv.sh is the one env-file reader setup/ctf-setup.sh,
# scripts/dev-stack, deploy/fly/deploy.sh and deploy/fly/render-compose.sh
# share. test/fixtures/dotenv-corpus.env pins its grammar: each `#> KEY|value`
# line is what docker compose reads for KEY out of that same file, and every
# reader here must read the same.
#
# Each test ends with its decisive assertion (AGENTS.md): a `[[ ]]` or a
# negated pipeline that is not last does not fail a bats test.

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  LIB="$REPO/scripts/lib/dotenv.sh"
  CORPUS="$REPO/test/fixtures/dotenv-corpus.env"
  cd "$BATS_TEST_TMPDIR"
}

# Run every `#> KEY|expected` line in the corpus through a reader command
# (`<reader> <file> <key>` must print the value) against <file>, and print one
# MISMATCH line per disagreement. Also prints the case count, so a corpus that
# lost its expectations cannot pass by checking nothing.
check_corpus() {
  local reader="$1" file="$2"
  bash -c '
    set -euo pipefail
    . "$1"
    reader="$2"; file="$3"; corpus="$4"
    if [ -f "$5" ]; then . "$5"; fi
    n=0
    while IFS= read -r line; do
      key="${line#\#> }"; key="${key%%|*}"; want="${line#*|}"
      got="$($reader "$file" "$key")"
      if [ "$got" != "$want" ]; then
        printf "MISMATCH %s: got [%s] want [%s]\n" "$key" "$got" "$want"
      fi
      n=$((n + 1))
    done < <(grep "^#> " "$corpus")
    echo "cases=$n"
  ' _ "$LIB" "$reader" "$file" "$CORPUS" "${3:-}"
}

@test "the corpus has its cases, including the SCORE_IMAGE ones" {
  [ "$(grep -c '^#> ' "$CORPUS")" -ge 20 ]
  grep -qx '#> SCORE_IMAGE|' "$CORPUS"
}

@test "dotenv_get reads every corpus case the way compose does" {
  run check_corpus dotenv_get "$CORPUS"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q '^cases=[1-9]'
  [ -z "$(echo "$output" | grep MISMATCH)" ]
}

@test "dotenv_get reads the CRLF form of the corpus identically" {
  awk '{ printf "%s\r\n", $0 }' "$CORPUS" > crlf.env
  # The conversion has to have happened, or this re-runs the LF test.
  [ -n "$(tr -dc '\r' < crlf.env)" ]
  run check_corpus dotenv_get crlf.env
  [ "$status" -eq 0 ]
  echo "$output" | grep -q '^cases=[1-9]'
  [ -z "$(echo "$output" | grep MISMATCH)" ]
}

@test "an empty SCORE_IMAGE is empty in every form it takes" {
  printf '%s\n' 'SCORE_IMAGE=' > a.env
  printf '%s\n' 'SCORE_IMAGE=""' > b.env
  printf '%s\n' "SCORE_IMAGE=''" > c.env
  printf '%s\n' 'export SCORE_IMAGE=""' > d.env
  printf 'SCORE_IMAGE=""\r\n' > e.env
  printf '%s\n' 'SCORE_IMAGE = ""  # app-only event' > f.env
  run bash -c '. "$1"; for f in a b c d e f; do printf "%s:[%s]\n" "$f" "$(dotenv_get "$f.env" SCORE_IMAGE)"; done' _ "$LIB"
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'a:[]\nb:[]\nc:[]\nd:[]\ne:[]\nf:[]')" ]
}

@test "a missing file reads as empty and does not fail under set -euo pipefail" {
  run bash -c 'set -euo pipefail; . "$1"; v="$(dotenv_get ./no-such.env SCORE_IMAGE)"; echo "[$v]"' _ "$LIB"
  [ "$status" -eq 0 ]
  [ "$output" = "[]" ]
}

@test "dotenv_has sees every assignment form, and no comment or absent key" {
  run bash -c '
    . "$1"
    for k in EMPTY DQ_EMPTY EXPORTED SPACED COLON INDENTED SCORE_IMAGE; do
      dotenv_has "$2" "$k" || echo "MISSED $k"
    done
    for k in ABSENT COMMENTED SCORE_IMAGE_; do
      if dotenv_has "$2" "$k"; then echo "PHANTOM $k"; fi
    done
    if dotenv_has ./no-such.env SCORE_IMAGE; then echo "PHANTOM missing-file"; fi
    echo done
  ' _ "$LIB" "$CORPUS"
  [ "$status" -eq 0 ]
  [ "$output" = done ]
}

@test "ctf-setup.sh's env_val reads the corpus exactly as the helper does" {
  # env_val reads ${OUT:-.env}; this adapter points OUT at the file so the
  # corpus runner can call it like any other reader. Sourced with
  # CMD=__selftest, which loads the helpers and runs nothing.
  cat > adapter.sh <<EOF
CMD=__selftest
# shellcheck source=/dev/null
. "$REPO/setup/ctf-setup.sh"
set +e
setup_env_val() { OUT="\$1" env_val "\$2"; }
EOF
  run check_corpus setup_env_val "$CORPUS" adapter.sh
  [ "$status" -eq 0 ]
  echo "$output" | grep -q '^cases=[1-9]'
  [ -z "$(echo "$output" | grep MISMATCH)" ]
}

@test "every env-file reader goes through the shared helper, and none keeps its own" {
  # dev-stack and the two Fly scripts cannot be sourced for one function the
  # way ctf-setup.sh can, so this pins the wiring instead: each sources
  # scripts/lib/dotenv.sh, and none carries a `sed -n "s/^KEY=//p"`-shaped
  # reader of its own (comments that name one are fine).
  local f bad=""
  for f in setup/ctf-setup.sh scripts/dev-stack deploy/fly/deploy.sh deploy/fly/render-compose.sh; do
    grep -q 'scripts/lib/dotenv.sh"\{0,1\}$' "$REPO/$f" || bad="$bad unsourced:$f"
    if grep -nE "sed -n [\"']s/\^[^/]*=//p" "$REPO/$f" | grep -v -e toml -e "^[0-9]*:[[:space:]]*#" >/dev/null; then
      bad="$bad own-reader:$f"
    fi
  done
  [ -z "$bad" ] || echo "readers off the shared helper:$bad"
  [ -z "$bad" ]
}
