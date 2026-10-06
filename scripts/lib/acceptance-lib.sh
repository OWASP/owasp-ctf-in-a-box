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
# functions are that common core: neither gate reimplements any of it any more
# (M15, #504), so a fix to the staging/build/judge path lands exactly once.
#
# The single-module gates (acceptance-quiz-only.sh, acceptance-classic-only.sh,
# acceptance-ai-only.sh) source this file too; their module-independent
# machinery — the compose line-up check, the redis/srh and app bring-ups, the
# sync refusal check — lives in the acc_* helpers at the bottom of this file.
#
# Portability: these run under bash on BSD (macOS) and GNU (Linux CI) userlands.
# No GNU-only sed/grep escapes.

# acc_url_for <target> — sets APP_SCHEME and APP_URL_SUFFIX for the target,
# from the one per-target URL table both scoring gates share.
#
# Some targets' apps hardcode a nonstandard listen port, a servlet context
# path, or both, inside their own image (there is no way to discover this at
# runtime — it is a fact about the vendor's Dockerfile/entrypoint, not
# something docker networking can smooth over). This mirrors the read-only
# reference engine's own per-target app-url convention (dc34
# .github/workflows/stock-scores-zero.yml): VAmPI's Flask app is hardcoded to
# `app.run(port=5000)`, so the suffix must carry :5000 or the app is simply
# unreachable at the default :80 — the exact "bad port" the stock gate exists
# to catch. VulnerableApp additionally hardcodes a servlet context path
# (`server.servlet.context-path=/VulnerableApp` baked into the image): the
# stock container 404s at `/` and only answers under `/VulnerableApp`, so its
# suffix carries the path as well as the port — verified directly against the
# stock image (`curl :9090/` -> 404, `curl :9090/VulnerableApp/allEndPointJson`
# -> 200). Hence APP_URL_SUFFIX, not APP_PORT: it is whatever string turns
# `http://$target` into the real, reachable app URL — port, path, or both.
#
# The SCHEME is per-target for the same reason: securityshepherd is the only
# one that speaks HTTPS (Tomcat's TLS connector on 8443, with a self-signed
# cert that expired in 2019 — its bring-up tolerates that rather than
# re-issuing it, because the rubric's helpers disable verification
# deliberately and several tests assert on TLS-level behaviour; the tolerance
# is scoped to the bring-up's own readiness probes, never exported into the
# judge). It defaults to http, so the other five compose exactly the URLs they
# always have.
#
# setup/ctf-setup.sh's app_url_for() carries the same per-target URL facts
# for the rendered organizer workflow. The two tables are intentionally NOT
# derived from one another (that script has provisioning side effects; these
# gates should not source it) — a new target's scheme and suffix need an entry
# in BOTH.
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

# acc_write_event <path> — the stock-check pull_request webhook payload the
# judge reads (author/pr/sha). The payload both scoring gates score.
acc_write_event() {
  cat > "$1" <<'JSON'
{"pull_request":{"user":{"login":"stock-check"},"number":1,"head":{"sha":"0000000000000000000000000000000000000000"}}}
JSON
}

# acc_run_judge — boot the app under test and score the rubric against it.
# Reads: IMG NET WS TMP TARGET APP_SCHEME APP_URL_SUFFIX and (optional)
# APP_IMAGE from the env (acc_url_for sets the two URL parts). An empty
# APP_IMAGE means "score from SOURCE" — the bring-up builds the staged
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
# ("**S / T** challenges patched"). The extraction both scoring gates use.
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

# The pre-launch lock: before launch a module page answers with a
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

# ---------------------------------------------------------------------------
# Single-module (*-only) gates: the machinery the quiz/classic/ai gates share.
#
# acceptance-quiz-only.sh, acceptance-classic-only.sh and acceptance-ai-only.sh
# run the SAME event for three different modules; everything below is that
# shared half, parameterized on the module label ("quiz"/"classic"/"ai"), a
# container-name prefix, or a compose project/override pair. The
# module-specific half — the seeded question/challenge JSON, the module page
# assertions, ai's extra routes — stays in each script.
# ---------------------------------------------------------------------------

# acc_compose_services [compose-args…] — `docker compose … config --services`
# for the base docker-compose.yml, echoing the sorted, space-separated service
# list. Every variable the base file interpolates is pinned to a dummy value:
# REDIS_PASSWORD is REQUIRED, not decorative — docker-compose.yml uses `:?` on
# it, so without a value `config` fails, and stderr is discarded here, which
# would turn that into an empty list. An empty list still fails loudly in
# acc_assert_module_lineups (the app/redis/srh loop below names the first
# service it could not find), never silently passes.
acc_compose_services() {
  SRH_TOKEN=acceptance SCORER_TOKEN=acceptance BETTER_AUTH_SECRET=acceptance \
    REDIS_PASSWORD=acceptance \
    GITHUB_CLIENT_ID=acceptance GITHUB_CLIENT_SECRET=acceptance \
    docker compose -f docker-compose.yml "$@" config --services 2>/dev/null | sort | tr '\n' ' '
}

# acc_assert_module_lineups <label> — the structural check every *-only gate
# runs first: render the documented single-module line-up (`--profile app`)
# and the scored line-up (`--profile secdev --profile app`), echo both, and
# assert BOTH directions — the module-only list must contain app/redis/srh and
# no scorer/sync (a module-only event has no scorer to pull), and the scored
# list must still contain all five (a fix that merely hid the scorer everywhere
# would break every real event). <label> is the module name; it is threaded
# into the header and every failure message so a miss names the line-up it
# missed. Returns 1 after printing the FAIL line.
acc_assert_module_lineups() {
  label="$1"
  # The article for the "'$svc' is in the …-only line-up" message, spelled the
  # way each gate already spells it ("a quiz-only event", "an ai-only event").
  case "$label" in
    [aeiou]*) article="an" ;;
    *) article="a" ;;
  esac
  echo "--- the documented $label-only profile set pulls no secure-development services"
  only="$(acc_compose_services --profile app)"
  scored="$(acc_compose_services --profile secdev --profile app)"
  printf '    %-36s %s\n' "$label-only (--profile app):" "$only"
  printf '    %-36s %s\n' "scored (--profile secdev + app):" "$scored"
  for svc in scorer sync; do
    case " $only " in
      *" $svc "*) echo "FAIL: '$svc' is in the $label-only line-up — $article $label-only event has no $svc"; return 1 ;;
    esac
  done
  for svc in app redis srh; do
    case " $only " in
      *" $svc "*) ;;
      *) echo "FAIL: '$svc' is missing from the $label-only line-up"; return 1 ;;
    esac
  done
  for svc in app redis srh scorer sync; do
    case " $scored " in
      *" $svc "*) ;;
      *) echo "FAIL: '$svc' is missing from the scored (secdev) line-up"; return 1 ;;
    esac
  done
}

# acc_boot_redis_srh <network> <container-prefix> <srh-token> — create the
# gate's private network (replacing any leftover of the same name) and boot
# the exact redis + srh images docker-compose.yml pins on it, with the
# network-alias names the app's in-network URLs resolve (redis, srh), then
# wait until redis answers PING. Containers are named "<prefix>-redis" and
# "<prefix>-srh". A silent redis fails with "FAIL: redis never answered"
# after 30s rather than letting the gate hang.
acc_boot_redis_srh() {
  net="$1"; pfx="$2"; token="$3"
  docker network rm "$net" >/dev/null 2>&1 || true
  docker network create "$net" >/dev/null

  echo "--- booting redis + srh"
  docker rm -f "$pfx-redis" "$pfx-srh" >/dev/null 2>&1 || true
  docker run -d --name "$pfx-redis" --network "$net" --network-alias redis \
    redis:7-alpine redis-server --appendonly yes >/dev/null
  docker run -d --name "$pfx-srh" --network "$net" --network-alias srh \
    -e SRH_MODE=env -e SRH_TOKEN="$token" -e SRH_CONNECTION_STRING=redis://redis:6379 \
    hiett/serverless-redis-http:latest@sha256:5b0bb9239fce53abf87b2018a7a0deb9ec7bd900c5360738fe5fbeeb426f9150 >/dev/null

  echo "--- waiting for redis"
  redis_deadline=$((SECONDS + 30))
  until docker exec "$pfx-redis" redis-cli ping 2>/dev/null | grep -q PONG; do
    [ "$SECONDS" -ge "$redis_deadline" ] && { echo "FAIL: redis never answered"; return 1; }
    sleep 1
  done
}

# acc_boot_app <name> <port> <image> <network> <srh-url> <srh-token>
# <github-org> <admin-logins> <auth-secret> — boot a *-only gate's app
# container: remove any leftover of the same name, then `docker run -d` the
# image on the gate's private network with <port> published on localhost.
# Every value that differs between gates is an argument (config v2, #386: the
# image takes NO build-time config — which modules run is an /admin setting in
# Redis, and GITHUB_ORG/ADMIN_LOGINS arrive as runtime env here). Only
# BETTER_AUTH_URL is derived — from <port>, the way all three gates spell it.
acc_boot_app() {
  name="$1"; port="$2"; img="$3"; net="$4"; srh_url="$5"; token="$6"
  org="$7"; logins="$8"; secret="$9"
  echo "--- booting the app"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --network "$net" -p "$port:3000" \
    -e BETTER_AUTH_SECRET="$secret" \
    -e BETTER_AUTH_URL="http://localhost:$port" \
    -e UPSTASH_REDIS_REST_URL="$srh_url" \
    -e UPSTASH_REDIS_REST_TOKEN="$token" \
    -e GITHUB_ORG="$org" \
    -e ADMIN_LOGINS="$logins" \
    "$img" >/dev/null
}

# acc_write_sync_override <path> — the compose override every *-only gate
# uses to bring sync up with GITHUB_ORG pinned empty, so the refusal the gate
# asserts is the deployed service definition refusing (see the comments in the
# heredoc; identical for all three gates).
acc_write_sync_override() {
  cat > "$1" <<'OVERRIDE'
services:
  sync:
    # `restart: "no"`, against the base file's `on-failure`: the refusal
    # asserted below is a non-zero exit, and on-failure would keep bringing
    # the container back underneath the exit-code and log checks — a race,
    # not a test. The deployed policy is deliberately the other way round
    # (an organizer wants the missing-key line to repeat until it is fixed).
    restart: "no"
    environment:
      # Pinned empty rather than merely left unset: `${GITHUB_ORG:-}` in the
      # base file would otherwise pick up a real org from the operator's
      # shell or from a `.env` beside docker-compose.yml, and the refusal
      # under test would silently become a live poller.
      GITHUB_ORG: ""
OVERRIDE
}

# acc_sync_compose <project> <override> [compose-args…] — run docker compose
# for a *-only gate's sync check: the REAL base docker-compose.yml plus the
# caller's GITHUB_ORG-pinned override, under the caller's compose project
# name, so the refusal under test is the deployed service definition's.
# REDIS_PASSWORD defaults to a dummy because the base file interpolates it
# with `:?` and will not resolve without a value.
acc_sync_compose() {
  sync_project="$1"; sync_override="$2"; shift 2
  REDIS_PASSWORD="${REDIS_PASSWORD:-acceptance}" \
    docker compose -p "$sync_project" -f docker-compose.yml -f "$sync_override" "$@"
}

# acc_assert_sync_refuses_no_org <project> <override> — bring the real
# docker-compose.yml's sync service up with GITHUB_ORG pinned empty (by the
# caller's override) and assert it REFUSES at start-up: the container exists,
# it stops, it exits non-zero, and it logs `ctf-sync: GITHUB_ORG is not set`
# — rather than coming up and polling nothing in silence (sync/src/config.js +
# index.js's main()). `ps -aq`, never `ps -q`: a fast-exiting container is
# exactly what this expects, and the running-only form races it and can
# misreport a PASS as "never started". Non-zero, not pinned to 1 exactly: what
# this proves is that the refusal is a FAILURE — visible to the restart
# policy, to CI and to an organizer's `compose ps` — not which number it
# picked. Every failure path prints the compose logs before returning 1.
acc_assert_sync_refuses_no_org() {
  sync_project="$1"; sync_override="$2"
  echo "--- bringing up sync (secdev profile) with no GITHUB_ORG"
  acc_sync_compose "$sync_project" "$sync_override" --profile secdev up -d --build --no-deps sync

  sync_cid="$(acc_sync_compose "$sync_project" "$sync_override" ps -aq sync)"
  [ -n "$sync_cid" ] || { echo "FAIL: sync container never started"; return 1; }

  echo "--- waiting for sync to refuse and exit"
  exit_deadline=$((SECONDS + 30))
  until [ "$(docker inspect -f '{{.State.Running}}' "$sync_cid")" = "false" ]; do
    [ "$SECONDS" -ge "$exit_deadline" ] && {
      echo "FAIL: sync never exited — it is still running with no GITHUB_ORG"
      acc_sync_compose "$sync_project" "$sync_override" logs sync
      return 1
    }
    sleep 1
  done

  sync_exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$sync_cid")"
  [ "$sync_exit_code" != "0" ] || {
    echo "FAIL: sync exited 0 with no GITHUB_ORG — a missing org must be a refusal, not a silent no-op"
    acc_sync_compose "$sync_project" "$sync_override" logs sync
    return 1
  }

  echo "--- sync named the missing key (not a swallowed crash)"
  if ! acc_sync_compose "$sync_project" "$sync_override" logs sync 2>&1 | grep -qF "ctf-sync: GITHUB_ORG is not set"; then
    echo "FAIL: sync exited $sync_exit_code but never logged 'ctf-sync: GITHUB_ORG is not set' — the refusal must name the key it wants"
    acc_sync_compose "$sync_project" "$sync_override" logs sync
    return 1
  fi
}

# acc_assert_leaderboard_contrib <base-url> <module> <login> <points-formatted>
# — /leaderboard must render a row for <login>, and that row must carry the
# module-contributed total <points-formatted>. A module-only event always
# resolves the leaderboard source to "empty" (lib/leaderboard/source.ts —
# secure-development disabled means no scorer/lambda/upstash backend is even
# consulted), so a row landing here at all can ONLY come from the
# module-contribution overlay reading real module totals — this is the one
# assertion a vacuous "app never came up" failure cannot fake.
#
# <points-formatted> must carry a thousands separator (e.g. 4,321): that is
# what makes the whole-page match safe — no bounded-window regex (one was
# measured off a machine's rendered markup, held locally and broke in CI with
# no message at all) — and impossible to satisfy by coincidence: no chunk id,
# hash or asset query contains a comma, and the seeded question/challenge
# price is deliberately chosen to differ from the total. Another reason to
# avoid bounded-repetition constructs here: some machines' `grep` is ugrep,
# which errors on some of them that GNU grep accepts.
acc_assert_leaderboard_contrib() {
  lb_base="$1"; lb_module="$2"; lb_login="$3"; lb_points_fmt="$4"
  echo "--- /leaderboard shows the seeded contestant by login, with their $lb_module points"
  lb_html="$(curl -sf "$lb_base/leaderboard")"
  if ! echo "$lb_html" | grep -qF "$lb_login"; then
    echo "FAIL: /leaderboard has no row for $lb_login — a contestant whose" >&2
    echo "      only points are $lb_module points did not get a row created at all." >&2
    return 1
  fi
  if ! echo "$lb_html" | grep -qF "$lb_points_fmt"; then
    echo "FAIL: /leaderboard shows $lb_login but not their $lb_module total" >&2
    echo "      ($lb_points_fmt) — the row exists, so the module" >&2
    echo "      overlay ran, but the points did not reach it." >&2
    return 1
  fi
}
