#!/usr/bin/env bash
# Proves a CLASSIC-ONLY event (the classic module alone switched on in
# /admin, no secure-development at all) runs a whole event end to end, with no
# scorer/poll pipeline behind it. This is the standalone-module composition
# promise (docs/modules.md): a single module must be enough to run an event
# alone. Sibling of scripts/acceptance-quiz-only.sh — read that file's header
# first; this one follows every one of its design decisions for classic's own
# module instead of quiz's.
#
# Asserts:
#   - the compose line-up docs/hosting.md tells a classic-only organizer to
#     run (`--profile app`) contains no secure-development service — no
#     scorer to pull, no poller — while the secure-development line-up
#     (`--profile secdev --profile app`, what a non-empty SCORE_IMAGE derives)
#     still contains both
#   - the app builds and comes up with NO build-time config at all (config v2,
#     issue #386: the image takes no config build-arg; which modules run is an
#     /admin setting in Redis, and GITHUB_ORG/ADMIN_LOGINS are runtime env)
#   - /flags serves and shows a seeded challenge BY TITLE
#   - /challenges 404s (module contract §5.4 — the route must not exist, not
#     just disappear from the nav; this is secure-development's own route,
#     gated on isModuleEnabled("secure-development") in
#     apps/web/src/app/(site)/challenges/page.tsx, which a classic-only event
#     never enables)
#   - /leaderboard shows a seeded contestant's classic points BY LOGIN. A
#     classic-only event always resolves the leaderboard source to "empty"
#     (lib/leaderboard/source.ts — secure-development disabled means no
#     scorer/lambda/upstash backend is even consulted), so a row landing here
#     at all can ONLY come from the module-contribution overlay reading real
#     classic totals — this is the one assertion a vacuous "app never came
#     up" failure cannot fake (see acceptance-quiz-only.sh's identical note,
#     and AGENTS.md's stock-scores-zero note for the same trap).
#   - `sync` REFUSES to start with no `GITHUB_ORG` — it logs
#     `ctf-sync: GITHUB_ORG is not set` and exits non-zero, rather than
#     polling nothing in silence (sync/src/config.js + index.js's main()).
#     Config v2 (#386) retired the old "nothing to poll, exit 0" path: the
#     poller reads its whole config from the environment now, so an empty
#     org is a misconfiguration, not a classic-only event
#
# Seeding: no OAuth app exists in CI, and the 'Seed demo data'
# button is admin-session-gated (apps/web/src/app/api/admin/seed/route.ts) —
# faking that session is out of scope and not something any script in this
# repo does. This script writes the classic module's real Redis schema
# directly, the same precedent acceptance-quiz-only.sh follows for quiz. Key
# names/builders come from apps/web/src/lib/classic-keys.ts; the challenge
# shape is the `Challenge` type in apps/web/src/lib/classic-store.ts
# (id, title, category, description, points, order — no flag field, ever).
#
# classic-store.ts documents NINE `ctf:classic:*` keys; this script writes
# the ones the assertions below actually exercise:
#   - ctf:classic:challenges   hash, id -> JSON Challenge (read by /flags)
#   - ctf:classic:flag         hash, id -> the flag AS AUTHORED (seeded for
#                               schema realism only — this script never
#                               submits a flag, so it is not independently
#                               asserted below)
#   - ctf:classic:flagnorm     hash, id -> normalizeFlag(flag) (same: realism
#                               only, not asserted)
#   - ctf:classic:categories   string, JSON array of category names
#   - ctf:classic:points       hash, login -> running points total (read by
#                               the leaderboard overlay's getClassicTotals)
#   - ctf:classic:solved       hash, login -> running solve count (ditto)
#   - ctf:classic:solves:<login> hash, id -> JSON {points, at} (seeded for
#                               realism — a real solve always writes this
#                               alongside the two aggregate hashes — but not
#                               independently asserted here)
#
# App: built directly via `docker build` (like acceptance-app.sh) and run
# standalone on a private network alongside real redis + srh images (the
# same ones docker-compose.yml pins) — a classic-only event never touches the
# scorer, so there is nothing compose-shaped to gain by bringing it up too.
#
# sync: brought up through the REAL docker-compose.yml via `docker compose`
# (overriding only `GITHUB_ORG` and the restart policy) specifically so the
# refusal below is the deployed service definition refusing, not a
# hand-rolled `docker run` this script could drift from.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/acceptance-lib.sh

NET=ctf-classic-only-acceptance-net
TMP=$(mktemp -d)
SRH_TOKEN="classic-only-acceptance-srh-token"
APP_PORT=3112
# Runtime env for the app container (config v2, #386) — there is no config
# file to put these in any more.
APP_GITHUB_ORG=acceptance-classic-org
APP_ADMIN_LOGINS=acceptance-classic-admin

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

SYNC_PROJECT=ctf-classic-only-sync-acceptance
sync_compose() {
  # Same requirement as compose_services above — the real docker-compose.yml
  # will not resolve without REDIS_PASSWORD.
  REDIS_PASSWORD="${REDIS_PASSWORD:-acceptance}" \
    docker compose -p "$SYNC_PROJECT" -f docker-compose.yml -f "$SYNC_OVERRIDE" "$@"
}

cleanup() {
  docker rm -f co-app co-redis co-srh >/dev/null 2>&1 || true
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
# The DOCUMENTED classic-only bring-up must be runnable as printed.
#
# This is a structural check on docker-compose.yml itself, deliberately made
# before anything heavy runs: the rest of this script builds and runs the app
# by hand (and brings sync up with --no-deps), so it can pass with flying
# colours while the command docs/hosting.md tells a classic-only organizer to
# run is unrunnable.
#
# Both directions are asserted: classic-only must not drag in
# secure-development's services, and the scored line-up must still contain
# them (a fix that merely hid the scorer everywhere would break every real
# event instead).
# ---------------------------------------------------------------------------
echo "--- the documented classic-only profile set pulls no secure-development services"
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
CLASSIC_SERVICES=$(compose_services --profile app)
SCORED_SERVICES=$(compose_services --profile secdev --profile app)
echo "    classic-only (--profile app):         $CLASSIC_SERVICES"
echo "    scored       (--profile secdev + app): $SCORED_SERVICES"
for svc in scorer sync; do
  case " $CLASSIC_SERVICES " in
    *" $svc "*) echo "FAIL: '$svc' is in the classic-only line-up — a classic-only event has no $svc"; exit 1 ;;
  esac
done
for svc in app redis srh; do
  case " $CLASSIC_SERVICES " in
    *" $svc "*) ;;
    *) echo "FAIL: '$svc' is missing from the classic-only line-up"; exit 1 ;;
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
# network. No scorer: a classic-only event never resolves to a scored
# leaderboard source, so there is nothing here for it to serve.
# ---------------------------------------------------------------------------
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null

echo "--- booting redis + srh"
docker rm -f co-redis co-srh >/dev/null 2>&1 || true
docker run -d --name co-redis --network "$NET" --network-alias redis \
  redis:7-alpine redis-server --appendonly yes >/dev/null
docker run -d --name co-srh --network "$NET" --network-alias srh \
  -e SRH_MODE=env -e SRH_TOKEN="$SRH_TOKEN" -e SRH_CONNECTION_STRING=redis://redis:6379 \
  hiett/serverless-redis-http:latest@sha256:5b0bb9239fce53abf87b2018a7a0deb9ec7bd900c5360738fe5fbeeb426f9150 >/dev/null

echo "--- waiting for redis"
redis_deadline=$((SECONDS + 30))
until docker exec co-redis redis-cli ping 2>/dev/null | grep -q PONG; do
  [ "$SECONDS" -ge "$redis_deadline" ] && { echo "FAIL: redis never answered"; exit 1; }
  sleep 1
done

# ---------------------------------------------------------------------------
# Seed the classic module's real Redis schema directly (see header comment
# for why). Key names/shapes are the canonical ones from
# apps/web/src/lib/classic-keys.ts and the `Challenge` type in
# apps/web/src/lib/classic-store.ts — this duplication fails CLOSED, not
# silently: a renamed key or a value shape parseChallenge()/parseCounterHash()
# (classic-store.ts) rejects yields a blank /flags or /leaderboard and a
# failed grep below, never a silent pass.
#
# One challenge (price 142) and one contestant. The contestant's TOTAL is a
# separate, deliberately larger figure (4321, >= 1000 so
# entry.points.toLocaleString() — leaderboard.tsx — comma-formats it to
# "4,321") specifically so the /leaderboard assertion below can tell "the
# totals hash" apart from "the challenge's own price": both would otherwise
# render as the same bare "142", and a bare unanchored grep for either could
# also coincidentally match a chunk id/hash elsewhere on the page.
#
# `ctf:classic:flag`, `ctf:classic:flagnorm` and `ctf:classic:solves:<login>`
# are seeded here for realism (a real solve always writes all of these
# together) but NOT independently asserted below — this script never
# exercises flag submission, so their shapes are not verified by anything
# here.
# ---------------------------------------------------------------------------
CHALLENGE_ID="acceptance-sqli-101"
CHALLENGE_TITLE="ACCEPTANCE-GATE-CHALLENGE: SQL Injection Basics"
CHALLENGE_CATEGORY="Web"
CHALLENGE_DESCRIPTION="Find the flag hidden in the login form."
CHALLENGE_POINTS=142
CHALLENGE_ORDER=1
CHALLENGE_FLAG="flag{acceptance-gate}"
CONTESTANT_LOGIN="classic-acceptance-bot"
CONTESTANT_POINTS=4321
CONTESTANT_POINTS_FORMATTED="4,321"

echo "--- seeding one classic challenge + one contestant's solve"
docker exec co-redis redis-cli HSET ctf:classic:challenges "$CHALLENGE_ID" \
  '{"id":"'"$CHALLENGE_ID"'","title":"'"$CHALLENGE_TITLE"'","category":"'"$CHALLENGE_CATEGORY"'","description":"'"$CHALLENGE_DESCRIPTION"'","points":'"$CHALLENGE_POINTS"',"order":'"$CHALLENGE_ORDER"'}' \
  >/dev/null
docker exec co-redis redis-cli SET ctf:classic:categories '["Web"]' >/dev/null
docker exec co-redis redis-cli HSET ctf:classic:flag "$CHALLENGE_ID" "$CHALLENGE_FLAG" >/dev/null
docker exec co-redis redis-cli HSET ctf:classic:flagnorm "$CHALLENGE_ID" "$CHALLENGE_FLAG" >/dev/null
docker exec co-redis redis-cli HSET ctf:classic:points "$CONTESTANT_LOGIN" "$CONTESTANT_POINTS" >/dev/null
docker exec co-redis redis-cli HSET ctf:classic:solved "$CONTESTANT_LOGIN" 1 >/dev/null
docker exec co-redis redis-cli HSET "ctf:classic:solves:$CONTESTANT_LOGIN" "$CHALLENGE_ID" \
  '{"points":'"$CHALLENGE_POINTS"',"at":"2026-08-19T00:00:00.000Z"}' >/dev/null

# Config v2 (#386): modules are switched on in ctf:admin:settings, and that
# hash is now the ONLY thing that enables one. Without this the board is OFF
# and /flags 404s.
docker exec co-redis redis-cli HSET ctf:admin:settings enabledModules classic >/dev/null

# ---------------------------------------------------------------------------
# Build + boot the app. NO build-args: config v2 (#386) removed the config
# bake, so which modules run comes from the Redis hash seeded above and
# GITHUB_ORG/ADMIN_LOGINS are passed as runtime env below — the same shape
# scripts/acceptance-app.sh uses.
# ---------------------------------------------------------------------------
echo "--- building app (no build-time config at all)"
docker build -f apps/web/Dockerfile -t ctf-web:classic-only-acceptance .

echo "--- booting the app"
docker rm -f co-app >/dev/null 2>&1 || true
docker run -d --name co-app --network "$NET" -p "$APP_PORT:3000" \
  -e BETTER_AUTH_SECRET=classic-only-acceptance-secret-32-characters-min \
  -e BETTER_AUTH_URL="http://localhost:$APP_PORT" \
  -e UPSTASH_REDIS_REST_URL=http://srh:80 \
  -e UPSTASH_REDIS_REST_TOKEN="$SRH_TOKEN" \
  -e GITHUB_ORG="$APP_GITHUB_ORG" \
  -e ADMIN_LOGINS="$APP_ADMIN_LOGINS" \
  ctf-web:classic-only-acceptance >/dev/null

APP_URL="http://localhost:$APP_PORT"
echo "--- waiting for /flags to serve (also waits out srh's startup lag — a"
echo "    classic read that hits srh before it's bound would 500, not hang)"
acc_wait_http "$APP_URL" 90 /flags || {
  echo "FAIL: /flags never returned 200"
  docker logs co-app 2>&1 | tail -80
  exit 1
}

echo "--- /flags shows the seeded challenge by title"
FLAGS_HTML=$(curl -sf "$APP_URL/flags")
if ! echo "$FLAGS_HTML" | grep -qF "$CHALLENGE_TITLE"; then
  echo "FAIL: /flags does not show '$CHALLENGE_TITLE'" >&2
  exit 1
fi

# The single most important property of this module: a real, seeded flag must
# never reach a contestant. Every unit test mocks @/lib/classic-store, so this
# is the only place in the whole suite where a real stored flag meets a real
# rendered /flags page — this assertion is the entire point of that setup.
echo "--- /flags never leaks the seeded flag itself"
if echo "$FLAGS_HTML" | grep -qF "$CHALLENGE_FLAG"; then
  echo "FAIL: /flags leaked the seeded flag ('$CHALLENGE_FLAG') to the page" >&2
  exit 1
fi

echo "--- /challenges 404s (no secure-development module — must not exist,"
echo "    not just be hidden from the nav)"
CHALLENGES_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/challenges")
[ "$CHALLENGES_CODE" = "404" ] || { echo "FAIL: /challenges returned $CHALLENGES_CODE, want 404"; exit 1; }

echo "--- /leaderboard shows the seeded contestant by login, with their classic points"
LEADERBOARD_HTML=$(curl -sf "$APP_URL/leaderboard")
if ! echo "$LEADERBOARD_HTML" | grep -qF "$CONTESTANT_LOGIN"; then
  echo "FAIL: /leaderboard has no row for $CONTESTANT_LOGIN — a contestant whose" >&2
  echo "      only points are classic points did not get a row created at all." >&2
  exit 1
fi

# The formatted TOTAL, matched across the whole page rather than inside a
# window around the login.
#
# acceptance-quiz-only.sh's identical assertion used to extract a fixed-width
# window (chained `.{0,200}` quantifiers, sized from an empirically measured
# character gap between the login and the total) and search inside it. That
# measurement is a property of one machine's rendered markup, not of the app:
# it held locally and broke in CI, where the gap fell outside the window and
# the assertion failed with no message at all. This assertion never repeats
# that mistake — no bounded-repetition regex, no measured window, whole-page
# match only. (Also: this machine's `grep` is ugrep, which errors on some
# bounded-repetition constructs GNU grep accepts — another reason to avoid
# them here.)
#
# A whole-page match is safe here because the expected string carries a
# thousands separator (`4,321`). The coincidence a windowed match was
# defending against is a digit run in a chunk id, hash or asset query — none
# of which contain commas. And CONTESTANT_POINTS is deliberately chosen to
# differ from the seeded challenge's price, so this still cannot be satisfied
# by the challenges hash rendering instead of the totals hash.
if ! echo "$LEADERBOARD_HTML" | grep -qF "$CONTESTANT_POINTS_FORMATTED"; then
  echo "FAIL: /leaderboard shows $CONTESTANT_LOGIN but not their classic total" >&2
  echo "      ($CONTESTANT_POINTS_FORMATTED) — the row exists, so the module" >&2
  echo "      overlay ran, but the points did not reach it." >&2
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

echo "ACCEPTANCE PASS (classic-only event)"
