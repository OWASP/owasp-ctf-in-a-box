#!/usr/bin/env bash
# Proves a QUIZ-ONLY event (the quiz module alone switched on in /admin, no
# secure-development at all) runs a whole event end to end, with no
# scorer/poll pipeline behind it. This is the standalone-module composition
# promise (docs/modules.md): a single module must be enough to run an event
# alone.
#
# Asserts:
#   - the compose line-up docs/hosting.md tells a quiz-only organizer to run
#     (`--profile app`) contains no secure-development service — no scorer to
#     pull, no poller — while the secure-development line-up (`--profile
#     secdev --profile app`, what a non-empty SCORE_IMAGE derives) still
#     contains both
#   - the app builds and comes up with NO build-time config at all (config v2,
#     issue #386: the image takes no config build-arg; which modules run is an
#     /admin setting in Redis, and GITHUB_ORG/ADMIN_LOGINS are runtime env)
#   - /quiz serves and shows a seeded question BY NAME
#   - /challenges 404s (module contract §5.4 — the route must not exist, not
#     just disappear from the nav; apps/web already pins this at the unit
#     level in app/(site)/challenges/__tests__/page-quiz-only.test.tsx, this
#     proves it through the real built app)
#   - /leaderboard shows a seeded contestant's quiz points BY LOGIN. A
#     quiz-only event always resolves the leaderboard source to "empty"
#     (lib/leaderboard/source.ts — secure-development disabled means no
#     scorer/lambda/upstash backend is even consulted), so a row landing here
#     at all can ONLY come from the module-contribution overlay reading real
#     quiz totals — this is the one assertion a vacuous "app never came up"
#     failure cannot fake (see the file header of scripts/acceptance-app.sh
#     and AGENTS.md's stock-scores-zero note for the same trap).
#   - `sync` REFUSES to start with no `GITHUB_ORG` — it logs
#     `ctf-sync: GITHUB_ORG is not set` and exits non-zero, rather than
#     polling nothing in silence (sync/src/config.js + index.js's main()).
#     Config v2 (#386) retired the old "nothing to poll, exit 0" path: the
#     poller reads its whole config from the environment now, so an empty
#     org is a misconfiguration, not a quiz-only event
#
# Seeding: no OAuth app exists in CI, and the 'Seed demo data'
# button is admin-session-gated (apps/web/src/app/api/admin/seed/route.ts) —
# faking that session is out of scope and not something any script in this
# repo does (dev-stack's own comment: it "does not fake or bypass that
# boundary"). Every existing acceptance/smoke script that needs
# admin-controlled state writes it straight to the same Redis the app reads
# (scripts/smoke.sh does this for ctf:admin:settings) rather than driving the
# authenticated route, and this script follows that precedent for the quiz
# module's exact real schema (key names from lib/quiz-keys.ts, question shape
# from lib/quiz-store.ts's `Question` type) — the same keys/shapes
# admin-store.ts's real seedDemoData would write, just written directly so
# the read side (getQuizTotals/listQuestions, exercised through the real
# built app) is what's actually under test.
#
# App: built directly via `docker build` (like acceptance-app.sh) and run
# standalone on a private network alongside real redis + srh images (the
# same ones docker-compose.yml pins) — a quiz-only event never touches the
# scorer, so there is nothing compose-shaped to gain by bringing it up too.
#
# sync: brought up through the REAL docker-compose.yml via `docker compose`
# (overriding only `GITHUB_ORG` and the restart policy) specifically so the
# refusal below is the deployed service definition refusing, not a
# hand-rolled `docker run` this script could drift from.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/acceptance-lib.sh

NET=ctf-quiz-only-acceptance-net
TMP=$(mktemp -d)
SRH_TOKEN="quiz-only-acceptance-srh-token"
APP_PORT=3110
# Runtime env for the app container (config v2, #386) — there is no config
# file to put these in any more.
APP_GITHUB_ORG=acceptance-quiz-org
APP_ADMIN_LOGINS=acceptance-quiz-admin

SYNC_OVERRIDE="$TMP/docker-compose.sync-override.yml"
cat > "$SYNC_OVERRIDE" <<'OVERRIDE'
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

SYNC_PROJECT=ctf-quiz-only-sync-acceptance
sync_compose() {
  # Same requirement as compose_services above — the real docker-compose.yml
  # will not resolve without REDIS_PASSWORD.
  REDIS_PASSWORD="${REDIS_PASSWORD:-acceptance}" \
    docker compose -p "$SYNC_PROJECT" -f docker-compose.yml -f "$SYNC_OVERRIDE" "$@"
}

cleanup() {
  docker rm -f qo-app qo-redis qo-srh >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  sync_compose down -v --remove-orphans >/dev/null 2>&1 || true
  # `compose down` was observed to silently no-op in local testing (exits 0,
  # prints nothing, container survives) — belt-and-suspenders direct removal
  # so a stray sync container/volume/network never outlives this script even
  # when that happens.
  docker rm -f "${SYNC_PROJECT}-sync-1" >/dev/null 2>&1 || true
  docker volume rm "${SYNC_PROJECT}_sync-state" "${SYNC_PROJECT}_redis-data" >/dev/null 2>&1 || true
  docker network rm "${SYNC_PROJECT}_default" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# The DOCUMENTED quiz-only bring-up must be runnable as printed.
#
# This is a structural check on docker-compose.yml itself, deliberately made
# before anything heavy runs: the rest of this script builds and runs the app
# by hand (and brings sync up with --no-deps), so it can pass with flying
# colours while the command docs/hosting.md tells a quiz-only organizer to run
# is unrunnable. That is exactly what happened — `scorer` had no `profiles:`
# key and `app` depended on it, so the documented line-up tried to pull the
# maintainers' PRIVATE scorer image on an event that has no scorer at all.
#
# Both directions are asserted: quiz-only must not drag in secure-development's
# services, and the scored line-up must still contain them (a fix that merely
# hid the scorer everywhere would break every real event instead).
# ---------------------------------------------------------------------------
echo "--- the documented quiz-only profile set pulls no secure-development services"
compose_services() {
  # REDIS_PASSWORD is REQUIRED, not decorative: docker-compose.yml uses `:?`
  # on it, so without a value `config` fails — and stderr is discarded here,
  # which would turn that into an empty service list and a silently vacuous
  # comparison below.
  SRH_TOKEN=acceptance SCORER_TOKEN=acceptance BETTER_AUTH_SECRET=acceptance \
    REDIS_PASSWORD=acceptance \
    GITHUB_CLIENT_ID=acceptance GITHUB_CLIENT_SECRET=acceptance \
    docker compose -f docker-compose.yml "$@" config --services 2>/dev/null | sort | tr '\n' ' '
}
QUIZ_SERVICES=$(compose_services --profile app)
SCORED_SERVICES=$(compose_services --profile secdev --profile app)
echo "    quiz-only (--profile app):            $QUIZ_SERVICES"
echo "    scored    (--profile secdev + app):   $SCORED_SERVICES"
for svc in scorer sync; do
  case " $QUIZ_SERVICES " in
    *" $svc "*) echo "FAIL: '$svc' is in the quiz-only line-up — a quiz-only event has no $svc"; exit 1 ;;
  esac
done
for svc in app redis srh; do
  case " $QUIZ_SERVICES " in
    *" $svc "*) ;;
    *) echo "FAIL: '$svc' is missing from the quiz-only line-up"; exit 1 ;;
  esac
done
for svc in app redis srh scorer sync; do
  case " $SCORED_SERVICES " in
    *" $svc "*) ;;
    *) echo "FAIL: '$svc' is missing from the scored (secdev) line-up"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# redis + srh (the exact images/config docker-compose.yml pins), on a private
# network. No scorer: a quiz-only event never resolves to a scored
# leaderboard source, so there is nothing here for it to serve.
# ---------------------------------------------------------------------------
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null

echo "--- booting redis + srh"
docker rm -f qo-redis qo-srh >/dev/null 2>&1 || true
docker run -d --name qo-redis --network "$NET" --network-alias redis \
  redis:7-alpine redis-server --appendonly yes >/dev/null
docker run -d --name qo-srh --network "$NET" --network-alias srh \
  -e SRH_MODE=env -e SRH_TOKEN="$SRH_TOKEN" -e SRH_CONNECTION_STRING=redis://redis:6379 \
  hiett/serverless-redis-http:latest@sha256:5b0bb9239fce53abf87b2018a7a0deb9ec7bd900c5360738fe5fbeeb426f9150 >/dev/null

echo "--- waiting for redis"
redis_deadline=$((SECONDS + 30))
until docker exec qo-redis redis-cli ping 2>/dev/null | grep -q PONG; do
  [ "$SECONDS" -ge "$redis_deadline" ] && { echo "FAIL: redis never answered"; exit 1; }
  sleep 1
done

# ---------------------------------------------------------------------------
# Seed the quiz's real Redis schema directly (see header comment for why).
# Key names/shapes are the canonical ones from apps/web/src/lib/quiz-keys.ts
# (ctf:quiz:questions, ctf:quiz:key, ctf:quiz:answers:<login>, ctf:quiz:points,
# ctf:quiz:answered) — this duplication fails CLOSED, not silently: a renamed
# key or a value shape parseQuestion()/parseCounterHash() (quiz-store.ts)
# rejects yields a blank /quiz or /leaderboard and a failed grep below, never
# a silent pass.
#
# One question (price 137) and one contestant. The contestant's TOTAL is a
# separate, deliberately larger figure (4321, >= 1000 so
# entry.points.toLocaleString() — leaderboard.tsx — comma-formats it to
# "4,321") specifically so the /leaderboard assertion below can tell "the
# totals hash" apart from "the question's own price": both would otherwise
# render as the same bare "137", and a bare unanchored grep for either could
# also coincidentally match a chunk id/hash elsewhere on the page.
#
# `ctf:quiz:key` and `ctf:quiz:answers:<login>` are seeded here for realism
# (a real answer always writes all five keys together) but NOT independently
# asserted below — this script never exercises grading, so their shapes are
# not verified by anything here.
# ---------------------------------------------------------------------------
QUESTION_ID="acceptance-xss-basics"
QUESTION_PROMPT="ACCEPTANCE-GATE-QUESTION: what does XSS stand for?"
QUESTION_POINTS=137
CONTESTANT_LOGIN="quiz-acceptance-bot"
CONTESTANT_POINTS=4321
CONTESTANT_POINTS_FORMATTED="4,321"

echo "--- seeding one quiz question + one contestant's answer"
docker exec qo-redis redis-cli HSET ctf:quiz:questions "$QUESTION_ID" \
  '{"id":"acceptance-xss-basics","prompt":"'"$QUESTION_PROMPT"'","type":"single","choices":[{"id":"a","label":"Cross-Site Scripting"},{"id":"b","label":"XML Signature Exchange"}],"points":'"$QUESTION_POINTS"',"order":1}' \
  >/dev/null
docker exec qo-redis redis-cli HSET ctf:quiz:key "$QUESTION_ID" '["a"]' >/dev/null
docker exec qo-redis redis-cli HSET "ctf:quiz:answers:$CONTESTANT_LOGIN" "$QUESTION_ID" \
  '{"choices":["a"],"points":'"$QUESTION_POINTS"',"at":"2026-08-19T00:00:00.000Z"}' >/dev/null
docker exec qo-redis redis-cli HSET ctf:quiz:points "$CONTESTANT_LOGIN" "$CONTESTANT_POINTS" >/dev/null
docker exec qo-redis redis-cli HSET ctf:quiz:answered "$CONTESTANT_LOGIN" 1 >/dev/null

# Config v2 (#386): modules are switched on in ctf:admin:settings, and that
# hash is now the ONLY thing that enables one. Without this the board is OFF
# and /quiz 404s.
docker exec qo-redis redis-cli HSET ctf:admin:settings enabledModules quiz >/dev/null

# ---------------------------------------------------------------------------
# Build + boot the app. NO build-args: config v2 (#386) removed the config
# bake, so which modules run comes from the Redis hash seeded above and
# GITHUB_ORG/ADMIN_LOGINS are passed as runtime env below — the same shape
# scripts/acceptance-app.sh uses.
# ---------------------------------------------------------------------------
echo "--- building app (no build-time config at all)"
docker build -f apps/web/Dockerfile -t ctf-web:quiz-only-acceptance .

echo "--- booting the app"
docker rm -f qo-app >/dev/null 2>&1 || true
docker run -d --name qo-app --network "$NET" -p "$APP_PORT:3000" \
  -e BETTER_AUTH_SECRET=quiz-only-acceptance-secret-32-characters-min \
  -e BETTER_AUTH_URL="http://localhost:$APP_PORT" \
  -e UPSTASH_REDIS_REST_URL=http://srh:80 \
  -e UPSTASH_REDIS_REST_TOKEN="$SRH_TOKEN" \
  -e GITHUB_ORG="$APP_GITHUB_ORG" \
  -e ADMIN_LOGINS="$APP_ADMIN_LOGINS" \
  ctf-web:quiz-only-acceptance >/dev/null

APP_URL="http://localhost:$APP_PORT"
echo "--- waiting for /quiz to serve (also waits out srh's startup lag — a"
echo "    quiz read that hits srh before it's bound would 500, not hang)"
acc_wait_http "$APP_URL" 90 /quiz || {
  echo "FAIL: /quiz never returned 200"
  docker logs qo-app 2>&1 | tail -80
  exit 1
}

echo "--- /quiz shows the seeded question by name"
QUIZ_HTML=$(curl -sf "$APP_URL/quiz")
# Guarded, not bare: a bare `grep -q` under `set -e` exits with no message at
# all — the failure mode acceptance-classic-only.sh documents having hit in CI.
# A here-string rather than a pipe: `grep -q` exits on the first match, and
# under `pipefail` a page larger than the pipe buffer would SIGPIPE the writer.
if ! grep -qF -- "$QUESTION_PROMPT" <<< "$QUIZ_HTML"; then
  echo "FAIL: /quiz does not show the seeded question '$QUESTION_PROMPT'"
  exit 1
fi

echo "--- /challenges 404s (no secure-development module — must not exist,"
echo "    not just be hidden from the nav)"
CHALLENGES_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/challenges")
[ "$CHALLENGES_CODE" = "404" ] || { echo "FAIL: /challenges returned $CHALLENGES_CODE, want 404"; exit 1; }

echo "--- /leaderboard shows the seeded contestant by login, with their quiz points"
LEADERBOARD_HTML=$(curl -sf "$APP_URL/leaderboard")
if ! echo "$LEADERBOARD_HTML" | grep -qF "$CONTESTANT_LOGIN"; then
  echo "FAIL: /leaderboard has no row for $CONTESTANT_LOGIN — a contestant whose" >&2
  echo "      only points are quiz points did not get a row created at all." >&2
  exit 1
fi

# The formatted TOTAL, matched across the whole page rather than inside a
# window around the login.
#
# This used to extract a fixed-width window (chained `.{0,200}` quantifiers,
# sized from an empirically measured ~350-char gap between the login and the
# total) and search inside it. That measurement is a property of one machine's
# rendered markup, not of the app: it held locally and broke in CI, where the
# gap falls outside the window and the assertion failed with no message at all
# — the job printed the step banner and died under `set -e`.
#
# A whole-page match is safe here because the expected string carries a
# thousands separator (`4,321`). The coincidence the window was defending
# against is a digit run in a chunk id, hash or asset query — none of which
# contain commas. And CONTESTANT_POINTS is deliberately chosen to differ from
# every seeded question price, so this still cannot be satisfied by the
# questions hash rendering instead of the totals hash.
if ! echo "$LEADERBOARD_HTML" | grep -qF "$CONTESTANT_POINTS_FORMATTED"; then
  echo "FAIL: /leaderboard shows $CONTESTANT_LOGIN but not their quiz total" >&2
  echo "      ($CONTESTANT_POINTS_FORMATTED) — the row exists, so the module" >&2
  echo "      overlay ran, but the points did not reach it." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Identity is a runtime setting (issue #386), not a build-time bake: rename
# through the hash — no rebuild, no restart — then prove the name reaches
# the HTML. Presence in Redis is not discoverability, so the read has to be
# a fresh request made AFTER the HSET, not the page fetched earlier.
# ---------------------------------------------------------------------------
echo "--- renaming the event at runtime and confirming the landing page picks it up"
docker exec qo-redis redis-cli HSET ctf:admin:settings eventName "Acceptance CTF" >/dev/null
RENAMED_HTML=$(curl -sf "$APP_URL/")
if ! grep -qF -- "Acceptance CTF" <<< "$RENAMED_HTML"; then
  echo "FAIL: landing page does not show the runtime event name"
  exit 1
fi
if grep -qF -- "<title>OWASP CTF in a Box</title>" <<< "$RENAMED_HTML"; then
  echo "FAIL: landing page title still shows the default after a rename"
  exit 1
fi

# ---------------------------------------------------------------------------
# sync: through the real docker-compose.yml (see header comment for why),
# overriding only GITHUB_ORG and the restart policy. With no org it must
# REFUSE at start-up — naming the key, with a non-zero exit — rather than
# come up and poll nothing.
# ---------------------------------------------------------------------------
echo "--- bringing up sync (secdev profile) with no GITHUB_ORG"
sync_compose --profile secdev up -d --build --no-deps sync

# `ps -q` (running only) races a fast-exiting container — exactly what this
# script expects sync to do — and can come back empty even though sync
# started and already refused, misreporting a PASS as "never started".
# `ps -aq` includes exited containers too.
SYNC_CID=$(sync_compose ps -aq sync)
[ -n "$SYNC_CID" ] || { echo "FAIL: sync container never started"; exit 1; }

echo "--- waiting for sync to refuse and exit"
exit_deadline=$((SECONDS + 30))
until [ "$(docker inspect -f '{{.State.Running}}' "$SYNC_CID")" = "false" ]; do
  [ "$SECONDS" -ge "$exit_deadline" ] && {
    echo "FAIL: sync never exited — it is still running with no GITHUB_ORG"
    sync_compose logs sync
    exit 1
  }
  sleep 1
done

# Non-zero, not pinned to 1 exactly: what this proves is that the refusal is
# a FAILURE — visible to the restart policy, to CI and to an organizer's
# `compose ps` — not which number it picked.
SYNC_EXIT_CODE=$(docker inspect -f '{{.State.ExitCode}}' "$SYNC_CID")
[ "$SYNC_EXIT_CODE" != "0" ] || {
  echo "FAIL: sync exited 0 with no GITHUB_ORG — a missing org must be a refusal, not a silent no-op"
  sync_compose logs sync
  exit 1
}

echo "--- sync named the missing key (not a swallowed crash)"
if ! sync_compose logs sync 2>&1 | grep -qF "ctf-sync: GITHUB_ORG is not set"; then
  echo "FAIL: sync exited $SYNC_EXIT_CODE but never logged 'ctf-sync: GITHUB_ORG is not set' — the refusal must name the key it wants"
  sync_compose logs sync
  exit 1
fi

echo "ACCEPTANCE PASS (quiz-only event)"
