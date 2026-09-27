# scripts/lib/acceptance-lib.sh
# shellcheck shell=bash
# Shared machinery for the acceptance gates. Sourced, never executed — no
# shebang on purpose; the `shell=bash` directive tells shellcheck the target.
#
# acceptance-target.sh proves the NEGATIVE direction (stock app scores 0/N);
# acceptance-patched.sh proves the POSITIVE direction (a correctly patched fork
# scores exactly the patched challenge). Both stage the same way, build the same
# scorer image, and run the same judge — the only differences are "apply a
# reference patch before the build" and "assert a different result". These
# functions are that common core, factored out so the positive gate reuses the
# negative gate's proven staging/build/judge path instead of reimplementing it.
#
# Portability: these run under bash on BSD (macOS) and GNU (Linux CI) userlands.
# No GNU-only sed/grep escapes.

# acc_url_for <target> — sets APP_SCHEME and APP_URL_SUFFIX for the target.
# This is the same per-target URL table acceptance-target.sh carries (see its
# header for why the suffix, not just a port, is per-target). Kept in lockstep
# with that table and setup/ctf-setup.sh's app_url_for(); a new target needs an
# entry in all three.
acc_url_for() {
  APP_SCHEME="http"
  case "$1" in
    vampi) APP_URL_SUFFIX=":5000" ;;
    vulnerableapp) APP_URL_SUFFIX=":9090/VulnerableApp" ;;
    juice-shop) APP_URL_SUFFIX=":3000" ;;
    webgoat) APP_URL_SUFFIX=":8080/WebGoat" ;;
    securityshepherd) APP_SCHEME="https"; APP_URL_SUFFIX=":8443" ;;
    *) APP_URL_SUFFIX="" ;;
  esac
}

# acc_build_scorer <image-tag> — build the scorer image with the vendored rubric.
acc_build_scorer() {
  echo "Building scorer image with the vendored rubric…"
  docker build -q -t "$1" scorer/ >/dev/null
}

# acc_stage_source <workspace> <repo> <ref> [require_dockerfile=1] — stage a pinned
# upstream tree into the workspace exactly the way a contestant's PR checkout looks:
# a fork tree with a root Dockerfile, so the bring-up takes the workspace-Dockerfile
# branch. Pins to a COMMIT (init + fetch + checkout, because `git clone -b` cannot
# take a bare SHA); asserts the Dockerfile precondition loudly rather than letting
# the bring-up fall through to a confusing "need APP_IMAGE or a workspace Dockerfile".
#
# Pass a 4th arg of "0" to SKIP that precondition — for a target whose reference
# patch itself ADDS the root Dockerfile (vulnerableapp's fork ships only
# Dockerfile.base + gradle). The caller still asserts the Dockerfile exists AFTER
# applying the patch, so a genuinely missing one is still caught, just later.
acc_stage_source() {
  ws="$1"; repo="$2"; ref="$3"; require_dockerfile="${4:-1}"
  echo "Staging $repo@${ref:0:12} into the workspace (source path)…"
  git init -q "$ws"
  git -C "$ws" remote add origin "https://github.com/$repo.git"
  git -C "$ws" fetch --depth 1 -q origin "$ref"
  git -C "$ws" checkout -q FETCH_HEAD
  if [ "$require_dockerfile" = "1" ] && [ ! -f "$ws/Dockerfile" ]; then
    echo "FAIL: $repo@$ref has no root Dockerfile — the bring-up's source branch"
    echo "keys on that file and would never fire."
    return 1
  fi
}

# acc_write_event <path> — the stock-check pull_request webhook payload the judge
# reads (author/pr/sha). Identical to acceptance-target.sh's.
acc_write_event() {
  cat > "$1" <<'JSON'
{"pull_request":{"user":{"login":"stock-check"},"number":1,"head":{"sha":"0000000000000000000000000000000000000000"}}}
JSON
}

# acc_run_judge — boot the app under test and score the rubric against it.
# Reads: IMG NET WS TMP TARGET APP_URL and (optional) APP_IMAGE from the env.
# An empty APP_IMAGE means "score from SOURCE" — the bring-up builds the staged
# workspace Dockerfile, the same branch a contestant's PR takes.
acc_run_judge() {
  docker run --rm \
    --network "$NET" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$WS:/github/workspace" \
    -v "$TMP/event.json:/github/event.json:ro" \
    -e "TARGET=$TARGET" \
    -e "APP_URL=$APP_SCHEME://$TARGET$APP_URL_SUFFIX" \
    -e "APP_IMAGE=${APP_IMAGE:-}" \
    -e "NETWORK=$NET" \
    --entrypoint /usr/local/bin/entrypoint.sh \
    "$IMG"
}

# acc_score_counts <report> — echo "SOLVED TOTAL" parsed from the score line
# ("**S / T** challenges patched"). Same extraction acceptance-target.sh uses.
acc_score_counts() {
  sed -n 's/.*\*\*\([0-9][0-9]*\) \/ \([0-9][0-9]*\)\*\* challenges patched.*/\1 \2/p' "$1"
}

# acc_boot_standalone <image> <container-name> <container-port> [docker -e flags…]
# — boot the app under test standalone, publishing its port on a random loopback
# host port, and echo the base URL (http://127.0.0.1:<hostport>). Used by the
# positive control: the judge tears down its OWN app instance, so the control
# needs a fresh boot of the same image.
#
# Any trailing args are passed verbatim to `docker run` before the image — the
# caller supplies the target's runtime env so the control probes the SAME mode
# the judge scored (vampi's `-e vulnerable=1`, juice-shop's `-e NODE_ENV=unsafe`,
# …). Passed as positional args, never a word-split string, so multi-token env
# is safe. A patch must serve under the vulnerable runtime, not by relying on a
# hardened flag the bring-up never sets.
acc_boot_standalone() {
  img="$1"; name="$2"; cport="${3:-5000}"; shift 3
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --rm --name "$name" -p "127.0.0.1::$cport" "$@" "$img" >/dev/null
  hp="$(docker port "$name" "$cport/tcp" | head -1 | sed 's/.*://')"
  [ -n "$hp" ] || return 1
  echo "http://127.0.0.1:$hp"
}

# acc_control_dvwa <ctrl-js-path> — the positive control for dvwa (CTRL_STRATEGY
# "with-db"). Unlike the single-container targets, dvwa needs a MariaDB sibling and
# a session/CSRF-gated DB init before anything serves real data, so it cannot use
# acc_boot_standalone. Boots CTRL_IMG + mariadb on a throwaway bridge network, then
# runs the caller's node control script INSIDE the scorer image (which has node) on
# that same network — the script inits the DB, logs in, sets the security level and
# probes the patched endpoint, asserting it still serves a real row. Reads globals
# CTRL_IMG, CTRL_NAME, CTRL_DB_NAME, IMG, CHALLENGE. Returns the script's exit code.
acc_control_dvwa() {
  cnet="ctf-ctrl-dvwa-net"
  docker network create "$cnet" >/dev/null 2>&1 || true
  docker rm -f "$CTRL_DB_NAME" "$CTRL_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$CTRL_DB_NAME" --network "$cnet" --network-alias db \
    -e MYSQL_ROOT_PASSWORD=dvwa -e MYSQL_DATABASE=dvwa \
    -e MYSQL_USER=dvwa -e MYSQL_PASSWORD='p@ssw0rd' \
    docker.io/library/mariadb:10 >/dev/null
  docker run -d --name "$CTRL_NAME" --network "$cnet" --network-alias dvwa \
    -e DB_SERVER=db -e DB_DATABASE=dvwa -e DB_USER=dvwa -e DB_PASSWORD='p@ssw0rd' \
    -e RECAPTCHA_PRIV_KEY='' -e RECAPTCHA_PUB_KEY='' -e DEFAULT_SECURITY_LEVEL=low \
    "$CTRL_IMG" >/dev/null
  rc=0
  docker run --rm --network "$cnet" \
    -e APP_URL="http://dvwa" -e CHALLENGE="$CHALLENGE" \
    -v "$1:/dvwa-ctrl.js:ro" \
    --entrypoint node "$IMG" /dvwa-ctrl.js || rc=$?
  docker rm -f "$CTRL_DB_NAME" "$CTRL_NAME" >/dev/null 2>&1 || true
  docker network rm "$cnet" >/dev/null 2>&1 || true
  return "$rc"
}

# acc_wait_http <base-url> [tries] [path] — poll GET <base><path> until it returns
# 200, or fail after `tries` seconds (default 60). `path` defaults to "/"; targets
# served under a context path (webgoat's /WebGoat, vulnerableapp's /VulnerableApp)
# pass their readiness path here because "/" 404s for them. curl is present on both
# macOS and the Ubuntu CI runner.
acc_wait_http() {
  base="$1"; tries="${2:-60}"; path="${3:-/}"; i=0
  while [ "$i" -lt "$tries" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$base$path" 2>/dev/null || true)"
    [ "$code" = "200" ] && return 0
    i=$((i + 1)); sleep 1
  done
  return 1
}

# The pre-launch lock (#464): before launch a module page answers with a
# redirect to the landing page. Asserts that for "$base$path", naming exactly
# what it got when it fails. Anti-vacuous by pairing: the caller launches
# (acc_launch) and then waits for the SAME page to answer 200, so the redirect
# seen here was the lock, not a broken page.
acc_assert_prelaunch_redirect() {
  base="$1"; path="$2"
  got="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$base$path" 2>/dev/null || true)"
  case "$got" in
    30[1278]" $base/"|30[1278]" $base") return 0 ;;
  esac
  echo "FAIL: before launch $path should redirect to $base/ (the launch lock), got: $got"
  return 1
}

# Launch the event on a test box: write the field /admin's Launch writes.
# A past instant, so "launched" holds whatever the container clock says.
acc_launch() {
  docker exec "$1" redis-cli HSET ctf:admin:settings scoringStartsAt "2000-01-01T00:00:00Z" >/dev/null
}
