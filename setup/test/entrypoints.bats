#!/usr/bin/env bats
#
# Structural + behavioural invariants for the per-target bring-ups
# (`scorer/entrypoints/*.sh`).
#
# These are the cheap guard rails around one expensive fact: `scripts/
# acceptance-target.sh <target> none` and the stock-scores-zero matrix prove the
# source path end to end, but that costs minutes of Maven and image builds per
# target. The tests here run in under a second and fail loudly if a later edit
# quietly removes the path, so nobody has to notice it in a 40-minute CI matrix.
#
# The bring-ups are POSIX-sh FRAGMENTS sourced by entrypoint.sh, which supplies
# NETWORK / APP_HOST / APP_URL / APP_CONTAINER / APP_IMAGE and reads BOOTED back
# out. The behavioural tests below reproduce that contract with a stubbed
# `docker` (and `node`) on PATH, so they exercise real branch selection without a
# Docker daemon, a network, or a single byte pulled.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  ENTRYPOINTS="$REPO_ROOT/scorer/entrypoints"

  # Every bring-up except securityshepherd offers the three-branch shape
  # (APP_IMAGE -> pull, workspace Dockerfile -> build the fork, else fail).
  # securityshepherd is the ONE documented exception and is listed by name, not
  # detected: a new target must be added here deliberately, so it cannot join the
  # exception by accident.
  SOURCE_BUILDERS="dvwa juice-shop vampi vulnerableapp webgoat"
  NO_IMAGE_BRANCH="securityshepherd"

  BIN="$BATS_TEST_TMPDIR/bin"
  WS="$BATS_TEST_TMPDIR/workspace"
  DOCKER_LOG="$BATS_TEST_TMPDIR/docker.log"
  mkdir -p "$BIN" "$WS"
  : > "$DOCKER_LOG"

  # Records every invocation and always succeeds. `-i` runs consume stdin so the
  # `tar … | docker run -i …` staging pipe never dies of SIGPIPE.
  cat > "$BIN/docker" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$DOCKER_LOG"
case " $* " in *" -i "*) cat >/dev/null ;; esac
exit 0
STUB
  # The readiness/registration probe. Nothing is listening; report success so the
  # fragment runs to the end and its later steps stay observable.
  cat > "$BIN/node" <<'STUB'
#!/bin/sh
exit 0
STUB
  chmod +x "$BIN/docker" "$BIN/node"
}

# Run a bring-up fragment the way entrypoint.sh does: POSIX sh, `set -eu`, with
# the same environment contract. $1 is the target, $2 the APP_IMAGE ("" = none).
run_bringup() {
  run env PATH="$BIN:$PATH" DOCKER_LOG="$DOCKER_LOG" \
    NETWORK=ctfnet APP_HOST="$1" APP_URL="http://$1:8080/WebGoat" \
    APP_CONTAINER="ctf-app-$1" APP_IMAGE="$2" GITHUB_WORKSPACE="$WS" \
    sh -eu "$ENTRYPOINTS/$1.sh"
}

@test "every bring-up covers the six kit targets and nothing else" {
  run bash -c "ls '$ENTRYPOINTS' | sed 's/\.sh\$//' | sort | tr '\n' ' '"
  [ "$status" -eq 0 ]
  [ "$output" = "dvwa juice-shop securityshepherd vampi vulnerableapp webgoat " ]
}

@test "no bring-up hard-requires APP_IMAGE" {
  # `: "${APP_IMAGE:?…}"` is how webgoat used to refuse to score a contestant's
  # own fork. Nothing may reintroduce it: a target that cannot be scored from the
  # PR's source is a target contestants cannot actually compete on.
  run grep -rnE '\$\{APP_IMAGE:\?' "$ENTRYPOINTS"
  [ "$status" -ne 0 ]
}

@test "every bring-up but securityshepherd builds the fork from a workspace Dockerfile" {
  for t in $SOURCE_BUILDERS; do
    f="$ENTRYPOINTS/$t.sh"
    # Keys on the file entrypoint.sh's own patch path keys on…
    grep -qF 'GITHUB_WORKSPACE:-/github/workspace}/Dockerfile' "$f" \
      || { echo "$t.sh: no workspace-Dockerfile branch"; return 1; }
    # …and produces the image the run step then boots.
    grep -qF 'ctf-app-under-test' "$f" \
      || { echo "$t.sh: never builds ctf-app-under-test"; return 1; }
  done
}

@test "securityshepherd is the only bring-up with no prebuilt-image branch" {
  # Documented in its own header: the WAR, the MariaDB schema and the Mongo seed
  # are outputs of one Maven run, so a prebuilt Tomcat image is incoherent. It
  # must still build from source, and must still say why.
  f="$ENTRYPOINTS/$NO_IMAGE_BRANCH.sh"
  run grep -qF 'ctf-app-under-test' "$f"
  [ "$status" -ne 0 ]
  grep -qF 'SS_UPSTREAM_REF' "$f"
}

@test "with neither an image nor a workspace Dockerfile, a bring-up fails loudly" {
  for t in $SOURCE_BUILDERS; do
    run_bringup "$t" ""
    [ "$status" -ne 0 ] || { echo "$t.sh exited 0 with nothing to boot"; return 1; }
    [[ "$output" == *"APP_IMAGE"* ]] || { echo "$t.sh: message never names APP_IMAGE: $output"; return 1; }
    [[ "$output" == *"Dockerfile"* ]] || { echo "$t.sh: message never names Dockerfile: $output"; return 1; }
  done
}

@test "webgoat builds the fork's jar and image, then boots what it built" {
  printf 'FROM scratch\n' > "$WS/Dockerfile"
  run_bringup webgoat ""
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }

  log="$(cat "$DOCKER_LOG")"
  # The jar has to exist before the image build — WebGoat's Dockerfile COPYs
  # target/webgoat-*.jar — so a Maven pass, in a container, over the staging volume.
  [[ "$log" == *"volume create webgoat_src"* ]] || { echo "no staging volume: $log"; return 1; }
  [[ "$log" == *"./mvnw"*"-DskipTests"* ]] || { echo "no Maven build: $log"; return 1; }
  [[ "$log" == *"docker build -t ctf-app-under-test"* ]] || { echo "no image build: $log"; return 1; }
  # …and the app that gets scored is the one just built, not something pulled.
  [[ "$log" == *"--name ctf-app-webgoat"*"ctf-app-under-test"* ]] || { echo "booted the wrong image: $log"; return 1; }
  [[ "$log" != *"docker pull"* ]] || { echo "pulled an image on the source path: $log"; return 1; }
  # The staging volume is not left behind to leak a GB of disk.
  [[ "$log" == *"volume rm -f webgoat_src"* ]] || { echo "staging volume leaked: $log"; return 1; }
}

@test "webgoat still pulls and boots APP_IMAGE when one is given" {
  printf 'FROM scratch\n' > "$WS/Dockerfile"   # present, and must be IGNORED
  run_bringup webgoat webgoat/webgoat:v2025.3
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }

  log="$(cat "$DOCKER_LOG")"
  [[ "$log" == *"pull webgoat/webgoat:v2025.3"* ]] || { echo "APP_IMAGE not pulled: $log"; return 1; }
  [[ "$log" == *"--name ctf-app-webgoat"*"webgoat/webgoat:v2025.3"* ]] || { echo "booted something other than APP_IMAGE: $log"; return 1; }
  [[ "$log" != *"mvnw"* ]] || { echo "built from source despite APP_IMAGE: $log"; return 1; }
}

@test "webgoat always exports the two docker-side recon values" {
  # An ABSENT (as opposed to empty) WEBGOAT_LEAKED_ADMIN_PW / WEBGOAT_DESER_PAYLOAD
  # sends misc-lessons.test.js down a `docker ps --filter publish=8080` fallback that
  # finds nothing here, permanently failing Challenges 72 and 74 whatever the patch
  # state. Both must be exported on BOTH boot paths, empty only when recon found
  # nothing. `set -a` makes the export visible to `env` in a sourcing shell.
  printf 'FROM scratch\n' > "$WS/Dockerfile"
  for img in "" webgoat/webgoat:v2025.3; do
    run env PATH="$BIN:$PATH" DOCKER_LOG="$DOCKER_LOG" \
      NETWORK=ctfnet APP_HOST=webgoat APP_URL=http://webgoat:8080/WebGoat \
      APP_CONTAINER=ctf-app-webgoat APP_IMAGE="$img" GITHUB_WORKSPACE="$WS" \
      sh -euc ". $ENTRYPOINTS/webgoat.sh >/dev/null 2>&1; env"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"WEBGOAT_LEAKED_ADMIN_PW="* ]] || { echo "APP_IMAGE='$img': leaked-pw var not exported"; return 1; }
    [[ "$output" == *"WEBGOAT_DESER_PAYLOAD="* ]] || { echo "APP_IMAGE='$img': deser payload var not exported"; return 1; }
    [[ "$output" == *"WEBWOLF_URL=http://webgoat:9090/WebWolf"* ]] || { echo "APP_IMAGE='$img': WEBWOLF_URL not exported"; return 1; }
  done
}

@test "the acceptance gate pins WebGoat source to a commit, never a branch or tag" {
  # A tag can be re-pointed and a branch always moves; either would score a
  # different app on some later run. Same discipline as SS_UPSTREAM_REF.
  run grep -qE '^WG_UPSTREAM_REF="\$\{WG_UPSTREAM_REF:-[0-9a-f]{40}\}"$' \
    "$REPO_ROOT/scripts/acceptance-target.sh"
  [ "$status" -eq 0 ]
}

@test "the acceptance gate stages that source into the workspace for 'none'" {
  # Into the WORKSPACE specifically: that is what makes `webgoat none` take the
  # same branch a contestant's PR takes instead of a gate-only shortcut. The
  # staging itself moved into acc_stage_source (#504 M15): the gate must still
  # hand it the WORKSPACE and the pinned ref, and the helper must still fetch
  # that exact commit into it and assert the root Dockerfile the bring-up keys
  # on — without both halves the source path is a shortcut again.
  missing=""
  grep -qF 'acc_stage_source "$WS" "$WG_UPSTREAM_REPO" "$WG_UPSTREAM_REF"' \
    "$REPO_ROOT/scripts/acceptance-target.sh" || missing="$missing gate-call"
  grep -qF 'git -C "$ws" fetch --depth 1 -q origin "$ref"' \
    "$REPO_ROOT/scripts/lib/acceptance-lib.sh" || missing="$missing lib-fetch-commit"
  grep -qF '[ ! -f "$ws/Dockerfile" ]' \
    "$REPO_ROOT/scripts/lib/acceptance-lib.sh" || missing="$missing lib-dockerfile-assert"
  [ -z "$missing" ] || { echo "FAIL: the 'none' source path no longer stages into the workspace (missing:$missing)"; return 1; }
}

@test "stock-scores-zero gates both WebGoat boot paths" {
  # Pair each `- target: x` with the `image:` line that follows it and assert the
  # two webgoat rows are present. One row proves the published image still scores
  # zero; the other proves the source path a contestant's PR takes does too.
  run awk '
    /- target:/ { t = $3 }
    /image:/    { i = $2; gsub(/"/, "", i); if (t != "") { print t, i; t = "" } }
  ' "$REPO_ROOT/.github/workflows/stock-scores-zero.yml"
  [ "$status" -eq 0 ]
  [[ "$output" == *"webgoat webgoat/webgoat:v2025.3"* ]] || { echo "image row missing: $output"; return 1; }
  [[ "$output" == *"webgoat none"* ]] || { echo "source row missing: $output"; return 1; }
  # Both rows must keep running even when one fails, or a red source row would
  # hide the state of the image row.
  grep -qF 'fail-fast: false' "$REPO_ROOT/.github/workflows/stock-scores-zero.yml"
}

@test "ci lints every bring-up with no quarantine and no widened rules" {
  ci="$REPO_ROOT/.github/workflows/ci.yml"
  grep -qF 'shellcheck -s sh --exclude=SC2034 scorer/entrypoints/*.sh' "$ci"
  # webgoat.sh was once linted in a separate step with SC2155/SC2016 excluded.
  # Nothing may exempt a single fragment or widen the rule set again.
  run grep -nE 'shellcheck.*entrypoints.*(SC2155|SC2016|grep -v)' "$ci"
  [ "$status" -ne 0 ]
}
