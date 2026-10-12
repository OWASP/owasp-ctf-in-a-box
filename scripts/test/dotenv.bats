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
  REJECTED="$REPO/test/fixtures/dotenv-corpus-rejected.env"
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

# ---------------------------------------------------------------------------
# Fail closed: a value the reader cannot read the way compose does is an
# error, never a value. An empty SCORE_IMAGE turns Secure Development OFF and
# a literal expression turns it ON, so neither may be guessed.
# ---------------------------------------------------------------------------

# Every `#! KEY|reason` case in the rejected corpus, run through dotenv_get
# against <file>. Prints one BAD line per case that did not fail with a
# message naming the key, the file and the reason, or that leaked the value.
check_rejected() {
  local file="$1"
  bash -c '
    . "$1"
    file="$2"; corpus="$3"; n=0
    while IFS= read -r line; do
      key="${line#\#! }"; key="${key%%|*}"; why="${line#*|}"
      raw="$(grep "^$key=" "$corpus" | tail -1)"; raw="${raw#*=}"
      if out="$(dotenv_get "$file" "$key" 2>err)"; then
        printf "BAD %s: accepted as [%s]\n" "$key" "$out"
      elif [ -n "$out" ]; then
        printf "BAD %s: printed a value on failure\n" "$key"
      else
        msg="$(cat err)"
        case "$msg" in *"$key"*) ;; *) printf "BAD %s: message does not name the key: %s\n" "$key" "$msg" ;; esac
        case "$msg" in *"$file"*) ;; *) printf "BAD %s: message does not name the file: %s\n" "$key" "$msg" ;; esac
        case "$msg" in *"$why"*) ;; *) printf "BAD %s: message lacks [%s]: %s\n" "$key" "$why" "$msg" ;; esac
        q="$(printf "\047")"; stripped="${raw#\"}"; stripped="${stripped#"$q"}"
        if [ ${#stripped} -ge 4 ]; then
          case "$msg" in *"$stripped"*) printf "BAD %s: message leaks the value\n" "$key" ;; esac
        fi
      fi
      n=$((n + 1))
    done < <(grep "^#! " "$corpus")
    echo "cases=$n"
  ' _ "$LIB" "$file" "$REJECTED"
}

@test "rejected corpus: every malformed or interpolated value is an error, never a value" {
  run check_rejected "$REJECTED"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q '^cases=[1-9]'
  [ -z "$(echo "$output" | grep '^BAD')" ] || { echo "$output"; false; }
}

@test "rejected corpus: the CRLF form is rejected identically" {
  awk '{ printf "%s\r\n", $0 }' "$REJECTED" > rejected-crlf.env
  run check_rejected rejected-crlf.env
  [ "$status" -eq 0 ]
  echo "$output" | grep -q '^cases=[1-9]'
  [ -z "$(echo "$output" | grep '^BAD')" ] || { echo "$output"; false; }
}

@test "an existing but unreadable file is an error, not an empty value" {
  printf 'SCORE_IMAGE=ghcr.io/fixture/score:latest\n' > locked.env
  chmod 000 locked.env
  target=locked.env
  # root reads through mode 000, so the chmod proves nothing there: use a
  # directory in the file's place, which nobody can read as an env file.
  if [ -r locked.env ]; then
    rm -f locked.env
    mkdir locked.env
  fi
  run bash -c '. "$1"; v="$(dotenv_get "$2" SCORE_IMAGE)"; echo "rc=$? [$v]"' _ "$LIB" "$target"
  chmod 600 locked.env 2>/dev/null || true
  echo "$output" | grep -qF 'cannot be read'
  echo "$output" | grep -qx 'rc=1 \[\]'
}

@test "a directory in place of the env file is an error, not an empty value" {
  mkdir dir.env
  run bash -c '. "$1"; v="$(dotenv_get dir.env SCORE_IMAGE)"; echo "rc=$? [$v]"' _ "$LIB"
  echo "$output" | grep -qF 'cannot be read'
  echo "$output" | grep -qx 'rc=1 \[\]'
}

@test "dotenv_check passes an absent file and a clean one, and fails on any bad key it is given" {
  run bash -c '
    . "$1"
    dotenv_check ./absent.env SCORE_IMAGE || echo "FAIL absent"
    dotenv_check "$2" SCORE_IMAGE PLAIN || echo "FAIL clean"
    if dotenv_check "$3" PLAIN BRACE_DEFAULT 2>/dev/null; then echo "FAIL bad passed"; fi
    echo done
  ' _ "$LIB" "$CORPUS" "$REJECTED"
  [ "$output" = done ]
}

# scripts/dev-stack runs from its own repo root, so it is exercised from a
# copy of that layout with a stub `docker` that records every call. `down`
# is the one subcommand that decides the compose profiles and then calls
# docker without building anything.
dev_stack_copy() {
  mkdir -p ds/scripts/lib stubs
  cp "$REPO/scripts/dev-stack" ds/scripts/dev-stack
  cp "$LIB" ds/scripts/lib/dotenv.sh
  printf '#!/bin/sh\necho "docker $*" >> "%s/docker.log"\nexit 0\n' "$PWD" > stubs/docker
  chmod +x stubs/docker
  : > docker.log
}

@test "dev-stack: a clean SCORE_IMAGE still adds the secdev profile (control)" {
  dev_stack_copy
  printf 'REDIS_PASSWORD=x\nSCORE_IMAGE=ghcr.io/fixture/score:latest\n' > ds/.env
  PATH="$PWD/stubs:$PATH" run env -u SCORE_IMAGE bash ds/scripts/dev-stack down
  [ "$status" -eq 0 ]
  grep -qF -- '--profile secdev' docker.log
}

@test "dev-stack: an unterminated SCORE_IMAGE quote stops it before any docker call" {
  dev_stack_copy
  printf 'REDIS_PASSWORD=x\nSCORE_IMAGE="ghcr.io/fixture/score:latest\n' > ds/.env
  PATH="$PWD/stubs:$PATH" run env -u SCORE_IMAGE bash ds/scripts/dev-stack down
  [ "$status" -ne 0 ]
  echo "$output" | grep -qF 'unterminated quote'
  [ ! -s docker.log ]
}

@test "dev-stack: an interpolated SCORE_IMAGE stops it before any docker call" {
  dev_stack_copy
  printf 'REDIS_PASSWORD=x\nSCORE_IMAGE=${SCORER_IMAGE:-}\n' > ds/.env
  PATH="$PWD/stubs:$PATH" run env -u SCORE_IMAGE bash ds/scripts/dev-stack down
  [ "$status" -ne 0 ]
  echo "$output" | grep -qF 'uses interpolation'
  [ ! -s docker.log ]
}

# ---------------------------------------------------------------------------
# Differential: the reader against `docker compose config` itself.
#
# The corpora pin the cases someone thought of. This generates every
# combination of key form, value form, line ending and "last of a duplicate"
# into ONE env file, has compose read all of it in ONE `config` call, and
# requires, for every key, that the reader either returns exactly compose's
# value or refuses (non-zero). Returning a DIFFERENT value is the one outcome
# that fails — that is a script and the box disagreeing about the event.
#
# Needs docker compose. Skips without it locally; CI sets
# DOTENV_BATS_REQUIRE_DOCKER=1, where a skip is a failure.
# ---------------------------------------------------------------------------

need_compose() {
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    return 0
  fi
  if [ "${DOTENV_BATS_REQUIRE_DOCKER:-}" = "1" ]; then
    echo "FAIL: docker compose is not available, and DOTENV_BATS_REQUIRE_DOCKER=1 forbids skipping the differential test" >&2
    return 1
  fi
  skip "docker compose not available (CI sets DOTENV_BATS_REQUIRE_DOCKER=1, where this is a failure)"
}

# Every value form, one per line, as the raw text after the key's separator
# (the first line is the empty value). Each must parse as ONE line to compose: an unterminated quote would make it
# continue onto the next line (or reject the whole file), so those live in
# dotenv-corpus-rejected.env instead.
differential_values() {
  cat <<'VALUES'

v
v w
v #c
v#c
v	#c
#c
v   
a\b
a\\b
a'b
a"b
$X
${X}
${X:-d}
$$
pa$5
a$
a$-b
\$X
'v'
''
'v #c'
'v' #c
'v'tail
'a\b'
'a\\b'
'a\'b'
'a"b'
'$X'
'${X}'
'$$'
"v"
""
"v #c"
"v" #c
"v"tail
"a\b"
"a\\b"
"a\"b"
"a'b"
"a\nb"
"$X"
"${X}"
"\$X"
"$$"
"pa$5"
VALUES
}

# Writes diff.env and diff.yml, and the key list to keys.txt.
generate_differential() {
  local n=0 sep form value eol key
  : > diff.env
  : > keys.txt
  while IFS= read -r value; do
    for form in plain export spaced colon; do
      for eol in lf crlf; do
        n=$((n + 1))
        key="$(printf 'K%04d' "$n")"
        case "$form" in
        plain) sep="$key=" ;;
        export) sep="export $key=" ;;
        spaced) sep="$key = " ;;
        colon) sep="$key: " ;;
        esac
        if [ "$eol" = crlf ]; then
          printf '%s%s\r\n' "$sep" "$value" >> diff.env
        else
          printf '%s%s\n' "$sep" "$value" >> diff.env
        fi
        echo "$key" >> keys.txt
      done
    done
    # The same value as the LAST of two assignments, after a non-empty one.
    n=$((n + 1))
    key="$(printf 'K%04d' "$n")"
    printf '%s=earlier-value\n%s=%s\n' "$key" "$key" "$value" >> diff.env
    echo "$key" >> keys.txt
  done < <(differential_values)
  {
    printf 'services:\n  x:\n    image: busybox\n    environment:\n'
    while IFS= read -r key; do
      printf '      %s: "[${%s-UNSET}]"\n' "$key" "$key"
    done < keys.txt
  } > diff.yml
}

@test "differential: the reader returns compose's value or refuses, never a different value" {
  need_compose
  generate_differential
  # A clean environment: compose interpolates `$X` from the shell, and the
  # reader refuses those, so nothing here may depend on what X happens to be.
  env -i PATH="$PATH" HOME="$HOME" docker compose --env-file diff.env -f diff.yml \
    config --format json > compose.json 2>compose.err
  mkdir -p got
  bash -c '
    . "$1"
    while IFS= read -r key; do
      if v="$(dotenv_get diff.env "$key" 2>/dev/null)"; then
        printf "%s" "$v" > "got/$key.ok"
      else
        : > "got/$key.refused"
      fi
    done < keys.txt
  ' _ "$LIB"
  run node -e '
    const fs = require("fs");
    const env = JSON.parse(fs.readFileSync("compose.json", "utf8")).services.x.environment;
    const keys = fs.readFileSync("keys.txt", "utf8").trim().split("\n");
    let matched = 0, refused = 0, bad = [];
    for (const k of keys) {
      // compose prints a literal `$` as `$$`; the brackets mark the value.
      const want = env[k].slice(1, -1).split("$$").join("$");
      if (fs.existsSync(`got/${k}.refused`)) { refused++; continue; }
      const got = fs.readFileSync(`got/${k}.ok`, "utf8");
      if (got === want) matched++;
      else bad.push(`DIVERGES ${k}: reader ${JSON.stringify(got)} compose ${JSON.stringify(want)}`);
    }
    for (const b of bad) console.log(b);
    console.log(`cases=${keys.length} matched=${matched} refused=${refused} diverged=${bad.length}`);
  '
  echo "$output"
  [ "$status" -eq 0 ]
  echo "$output" | grep -qE '^cases=[0-9]{3,} matched=[1-9]'
  echo "$output" | grep -q ' diverged=0$'
}
