#!/usr/bin/env bash
# Proves an AI-ONLY event (the ai module alone switched on in /admin, no
# secure-development at all) runs a whole event end to end, with no
# scorer/poll pipeline behind it.
# This is the standalone-module composition promise (docs/modules.md): a
# single module must be enough to run an event alone. Sibling of
# scripts/acceptance-quiz-only.sh and scripts/acceptance-classic-only.sh —
# read classic's header first; this one follows every one of its design
# decisions for the ai module instead, plus one check neither sibling has
# (the launch-key endpoint, below).
#
# Asserts:
#   - the compose line-up docs/hosting.md tells an ai-only organizer to run
#     (`--profile app`) contains no secure-development service — no scorer to
#     pull, no poller — while the secure-development line-up (`--profile
#     secdev --profile app`, what a non-empty SCORE_IMAGE derives) still
#     contains both
#   - the app builds and comes up with NO build-time config at all (config v2,
#     issue #386: the image takes no config build-arg; which modules run is an
#     /admin setting in Redis, and GITHUB_ORG/ADMIN_LOGINS are runtime env)
#   - /ai serves and shows a seeded challenge BY TITLE
#   - /ai/<id> 200s for that challenge, and /ai/<bad-id> 404s (issue #209's
#     dual-cause not-found — an unknown id must 404 same as a disabled module)
#   - /challenges, /flags and /quiz all 404 (module contract §5.4 — those
#     routes must not exist, not just disappear from the nav; an ai-only
#     event never enables classic, quiz or secure-development)
#   - /leaderboard shows a seeded contestant's ai points BY LOGIN. An ai-only
#     event always resolves the leaderboard source to "empty"
#     (lib/leaderboard/source.ts — secure-development disabled means no
#     scorer/lambda/upstash backend is even consulted), so a row landing here
#     at all can ONLY come from the module-contribution overlay reading real
#     ai totals — this is the one assertion a vacuous "app never came up"
#     failure cannot fake (see acceptance-classic-only.sh's identical note,
#     and AGENTS.md's stock-scores-zero note for the same trap).
#   - `GET /api/ai/launch-key` 200s with `"alg":"Ed25519"` and a PEM-encoded
#     public key in the body. THE ai-specific check no sibling module has: an
#     external integrator has to verify a launch token against this endpoint
#     with no OAuth, no cookie and no admin session available to it at all
#     (ADR 53) — this proves the public identity endpoint mints its keypair
#     lazily and serves it correctly on a cold box, not just that some route
#     under it returns 200.
#   - `sync` REFUSES to start with no `GITHUB_ORG` — it logs
#     `ctf-sync: GITHUB_ORG is not set` and exits non-zero, rather than
#     polling nothing in silence (sync/src/config.js + index.js's main()).
#     Config v2 (#386) retired the old "nothing to poll, exit 0" path: the
#     poller reads its whole config from the environment now, so an empty
#     org is a misconfiguration, not an ai-only event
#
# Seeding: no OAuth app exists in CI, and the 'Seed demo data'
# button is admin-session-gated (apps/web/src/app/api/admin/seed/route.ts) —
# faking that session is out of scope and not something any script in this
# repo does. This script writes the ai module's real Redis schema directly,
# the same precedent acceptance-quiz-only.sh and acceptance-classic-only.sh
# follow. Key names/builders come from apps/web/src/lib/ai-keys.ts, the public
# challenge shape is the `AiChallenge` type in apps/web/src/lib/ai-store.ts
# (id, title, category, description, points, order, mode, urlTemplate — never
# a flag, hint or signing key, which live in their own SECRET hashes), and the
# solve row shape (`{points, at, source}`) is the literal AWARD_SCRIPT writes
# in ai-store.ts.
#
# ai-store.ts documents NINE `ctf:ai:*` keys this script seeds — four of them
# (challenges, categories, points, solved) are read along the requests this
# script's assertions make, plus five more it seeds for realism only (flag,
# flagnorm, signkey, solvecount, solves:<login> — each marked below, since
# this script never submits a flag, signs an event, or reads a solvecount):
#   - ctf:ai:challenges        hash, id -> JSON AiChallenge (read by /ai)
#   - ctf:ai:categories        string, JSON array of category names
#   - ctf:ai:flag              hash, id -> the flag AS AUTHORED (seeded for
#                               schema realism only — this script never
#                               submits a flag, so it is not independently
#                               asserted below)
#   - ctf:ai:flagnorm          hash, id -> flagComparisonForm(flag,
#                               caseSensitive) (same: realism only, not
#                               asserted. The authored flag below is already
#                               lowercase/trimmed, so its comparison form IS
#                               the literal — the seed writes the same string
#                               to both hashes, like classic's script does)
#   - ctf:ai:signkey           hash, id -> the challenge's event-signing key
#                               (realism only — this script never signs an
#                               event)
#   - ctf:ai:points            hash, login -> running points total (read by
#                               the leaderboard overlay's getAiTotals)
#   - ctf:ai:solved            hash, login -> running solve count (ditto)
#   - ctf:ai:solvecount        hash, id -> distinct-solver count (seeded for
#                               realism only — /ai renders it per challenge
#                               but this script does not assert on it)
#   - ctf:ai:solves:<login>    hash, id -> JSON {points, at, source} (seeded
#                               for realism — a real award always writes this
#                               alongside the two aggregate hashes — but not
#                               independently asserted here)
#
# Deliberately NOT seeded: ctf:ai:launchkey. That module-wide Ed25519 keypair
# is minted LAZILY on first use (getAiLaunchKeys in ai-store.ts) — writing one
# here would only prove a fixture round-trips, not that a cold box mints one
# correctly. The /api/ai/launch-key assertion below exercises exactly that
# lazy-mint path against a box that has never touched the key before.
#
# App: built directly via `docker build` (like acceptance-app.sh) and run
# standalone on a private network alongside real redis + srh images (the same
# ones docker-compose.yml pins) — an ai-only event never touches the scorer,
# so there is nothing compose-shaped to gain by bringing it up too.
#
# sync: brought up through the REAL docker-compose.yml via `docker compose`
# (overriding only `GITHUB_ORG` and the restart policy) specifically so the
# refusal below is the deployed service definition refusing, not a
# hand-rolled `docker run` this script could drift from.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/acceptance-lib.sh

NET=ctf-ai-only-acceptance-net
TMP=$(mktemp -d)
SRH_TOKEN="ai-only-acceptance-srh-token"
APP_PORT=3113
# Runtime env for the app container (config v2, #386) — there is no config
# file to put these in any more.
APP_GITHUB_ORG=acceptance-ai-org
APP_ADMIN_LOGINS=acceptance-ai-admin

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

SYNC_PROJECT=ctf-ai-only-sync-acceptance
sync_compose() {
  # Same requirement as compose_services above — the real docker-compose.yml
  # will not resolve without REDIS_PASSWORD.
  REDIS_PASSWORD="${REDIS_PASSWORD:-acceptance}" \
    docker compose -p "$SYNC_PROJECT" -f docker-compose.yml -f "$SYNC_OVERRIDE" "$@"
}

cleanup() {
  docker rm -f ao-app ao-redis ao-srh >/dev/null 2>&1 || true
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
# The DOCUMENTED ai-only bring-up must be runnable as printed.
#
# This is a structural check on docker-compose.yml itself, deliberately made
# before anything heavy runs: the rest of this script builds and runs the app
# by hand (and brings sync up with --no-deps), so it can pass with flying
# colours while the command docs/hosting.md tells an ai-only organizer to run
# is unrunnable.
#
# Both directions are asserted: ai-only must not drag in secure-development's
# services, and the scored line-up must still contain them (a fix that merely
# hid the scorer everywhere would break every real event instead).
# ---------------------------------------------------------------------------
echo "--- the documented ai-only profile set pulls no secure-development services"
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
AI_SERVICES=$(compose_services --profile app)
SCORED_SERVICES=$(compose_services --profile secdev --profile app)
echo "    ai-only (--profile app):              $AI_SERVICES"
echo "    scored  (--profile secdev + app):     $SCORED_SERVICES"
for svc in scorer sync; do
  case " $AI_SERVICES " in
    *" $svc "*) echo "FAIL: '$svc' is in the ai-only line-up — an ai-only event has no $svc"; exit 1 ;;
  esac
done
for svc in app redis srh; do
  case " $AI_SERVICES " in
    *" $svc "*) ;;
    *) echo "FAIL: '$svc' is missing from the ai-only line-up"; exit 1 ;;
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
# network. No scorer: an ai-only event never resolves to a scored leaderboard
# source, so there is nothing here for it to serve.
# ---------------------------------------------------------------------------
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null

echo "--- booting redis + srh"
docker rm -f ao-redis ao-srh >/dev/null 2>&1 || true
docker run -d --name ao-redis --network "$NET" --network-alias redis \
  redis:7-alpine redis-server --appendonly yes >/dev/null
docker run -d --name ao-srh --network "$NET" --network-alias srh \
  -e SRH_MODE=env -e SRH_TOKEN="$SRH_TOKEN" -e SRH_CONNECTION_STRING=redis://redis:6379 \
  hiett/serverless-redis-http:latest@sha256:5b0bb9239fce53abf87b2018a7a0deb9ec7bd900c5360738fe5fbeeb426f9150 >/dev/null

echo "--- waiting for redis"
redis_deadline=$((SECONDS + 30))
until docker exec ao-redis redis-cli ping 2>/dev/null | grep -q PONG; do
  [ "$SECONDS" -ge "$redis_deadline" ] && { echo "FAIL: redis never answered"; exit 1; }
  sleep 1
done

# ---------------------------------------------------------------------------
# Seed the ai module's real Redis schema directly (see header comment for
# why). Key names/shapes are the canonical ones from
# apps/web/src/lib/ai-keys.ts and the `AiChallenge` type in
# apps/web/src/lib/ai-store.ts — this duplication fails CLOSED, not silently:
# a renamed key or a value shape parseChallenge()/parseCounterHash()
# (ai-store.ts) rejects yields a blank /ai or /leaderboard and a failed grep
# below, never a silent pass.
#
# One challenge, `mode: "flag"` (price 155) and one contestant. The
# contestant's TOTAL is a separate, deliberately larger figure (4321, >= 1000
# so entry.points.toLocaleString() — leaderboard.tsx — comma-formats it to
# "4,321") specifically so the /leaderboard assertion below can tell "the
# totals hash" apart from "the challenge's own price": both would otherwise
# render as the same bare number, and a bare unanchored grep for either could
# also coincidentally match a chunk id/hash elsewhere on the page.
#
# `ctf:ai:flag`, `ctf:ai:flagnorm`, `ctf:ai:signkey`, `ctf:ai:solvecount` and
# `ctf:ai:solves:<login>` are seeded here for realism (a real award always
# writes all of these together) but NOT independently asserted below — this
# script never exercises flag submission or event grading, so their shapes
# are not verified by anything here.
# ---------------------------------------------------------------------------
CHALLENGE_ID="acceptance-prompt-injection"
CHALLENGE_TITLE="ACCEPTANCE-GATE-CHALLENGE: Prompt Injection Basics"
CHALLENGE_CATEGORY="AI"
CHALLENGE_DESCRIPTION="Convince the assistant behind this link to reveal its system prompt."
CHALLENGE_POINTS=155
CHALLENGE_ORDER=1
CHALLENGE_MODE="flag"
CHALLENGE_URL_TEMPLATE="https://ai-demo.example.org/launch?token={token}"
CHALLENGE_FLAG="ctfbox{acceptance-gate}"
CHALLENGE_SIGNKEY="aik_demo00000000000000000000000000000000000000acc1"
BAD_CHALLENGE_ID="acceptance-does-not-exist"
CONTESTANT_LOGIN="ai-acceptance-bot"
CONTESTANT_POINTS=4321
CONTESTANT_POINTS_FORMATTED="4,321"

echo "--- seeding one ai challenge + one contestant's solve"
docker exec ao-redis redis-cli HSET ctf:ai:challenges "$CHALLENGE_ID" \
  '{"id":"'"$CHALLENGE_ID"'","title":"'"$CHALLENGE_TITLE"'","category":"'"$CHALLENGE_CATEGORY"'","description":"'"$CHALLENGE_DESCRIPTION"'","points":'"$CHALLENGE_POINTS"',"order":'"$CHALLENGE_ORDER"',"mode":"'"$CHALLENGE_MODE"'","urlTemplate":"'"$CHALLENGE_URL_TEMPLATE"'"}' \
  >/dev/null
docker exec ao-redis redis-cli SET ctf:ai:categories '["AI"]' >/dev/null
docker exec ao-redis redis-cli HSET ctf:ai:flag "$CHALLENGE_ID" "$CHALLENGE_FLAG" >/dev/null
docker exec ao-redis redis-cli HSET ctf:ai:flagnorm "$CHALLENGE_ID" "$CHALLENGE_FLAG" >/dev/null
docker exec ao-redis redis-cli HSET ctf:ai:signkey "$CHALLENGE_ID" "$CHALLENGE_SIGNKEY" >/dev/null
docker exec ao-redis redis-cli HSET ctf:ai:points "$CONTESTANT_LOGIN" "$CONTESTANT_POINTS" >/dev/null
docker exec ao-redis redis-cli HSET ctf:ai:solved "$CONTESTANT_LOGIN" 1 >/dev/null
docker exec ao-redis redis-cli HSET ctf:ai:solvecount "$CHALLENGE_ID" 1 >/dev/null
docker exec ao-redis redis-cli HSET "ctf:ai:solves:$CONTESTANT_LOGIN" "$CHALLENGE_ID" \
  '{"points":'"$CHALLENGE_POINTS"',"at":"2026-08-19T00:00:00.000Z","source":"flag"}' >/dev/null

# Config v2 (#386): modules are switched on in ctf:admin:settings, and that
# hash is now the ONLY thing that enables one. Without this the board is OFF
# and /ai 404s.
docker exec ao-redis redis-cli HSET ctf:admin:settings enabledModules ai >/dev/null

# ---------------------------------------------------------------------------
# Build + boot the app. NO build-args: config v2 (#386) removed the config
# bake, so which modules run comes from the Redis hash seeded above and
# GITHUB_ORG/ADMIN_LOGINS are passed as runtime env below — the same shape
# scripts/acceptance-app.sh uses.
# ---------------------------------------------------------------------------
echo "--- building app (no build-time config at all)"
docker build -f apps/web/Dockerfile -t ctf-web:ai-only-acceptance .

echo "--- booting the app"
docker rm -f ao-app >/dev/null 2>&1 || true
docker run -d --name ao-app --network "$NET" -p "$APP_PORT:3000" \
  -e BETTER_AUTH_SECRET=ai-only-acceptance-secret-32-characters-min \
  -e BETTER_AUTH_URL="http://localhost:$APP_PORT" \
  -e UPSTASH_REDIS_REST_URL=http://srh:80 \
  -e UPSTASH_REDIS_REST_TOKEN="$SRH_TOKEN" \
  -e GITHUB_ORG="$APP_GITHUB_ORG" \
  -e ADMIN_LOGINS="$APP_ADMIN_LOGINS" \
  ctf-web:ai-only-acceptance >/dev/null

APP_URL="http://localhost:$APP_PORT"
echo "--- waiting for /ai to serve (also waits out srh's startup lag — an"
echo "    ai read that hits srh before it's bound would 500, not hang)"
acc_wait_http "$APP_URL" 90 /ai || {
  echo "FAIL: /ai never returned 200"
  docker logs ao-app 2>&1 | tail -80
  exit 1
}

echo "--- /ai shows the seeded challenge by title"
AI_HTML=$(curl -sf "$APP_URL/ai")
if ! echo "$AI_HTML" | grep -qF "$CHALLENGE_TITLE"; then
  echo "FAIL: /ai does not show '$CHALLENGE_TITLE'" >&2
  exit 1
fi

# The single most important property of this module: a real, seeded flag must
# never reach a contestant.
echo "--- /ai never leaks the seeded flag itself"
if echo "$AI_HTML" | grep -qF "$CHALLENGE_FLAG"; then
  echo "FAIL: /ai leaked the seeded flag ('$CHALLENGE_FLAG') to the page" >&2
  exit 1
fi

echo "--- /ai/<id> 200s for the seeded challenge"
CHALLENGE_PAGE_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/ai/$CHALLENGE_ID")
[ "$CHALLENGE_PAGE_CODE" = "200" ] || {
  echo "FAIL: /ai/$CHALLENGE_ID returned $CHALLENGE_PAGE_CODE, want 200"
  exit 1
}

echo "--- /ai/<bad-id> 404s (issue #209's dual-cause not-found — an unknown"
echo "    challenge id must 404, not just be absent from the board)"
BAD_CHALLENGE_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/ai/$BAD_CHALLENGE_ID")
[ "$BAD_CHALLENGE_CODE" = "404" ] || {
  echo "FAIL: /ai/$BAD_CHALLENGE_ID returned $BAD_CHALLENGE_CODE, want 404"
  exit 1
}

echo "--- /challenges, /flags and /quiz all 404 (no secure-development, classic"
echo "    or quiz module — must not exist, not just be hidden from the nav)"
for route in /challenges /flags /quiz; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL$route")
  [ "$code" = "404" ] || { echo "FAIL: $route returned $code, want 404"; exit 1; }
done

echo "--- /leaderboard shows the seeded contestant by login, with their ai points"
LEADERBOARD_HTML=$(curl -sf "$APP_URL/leaderboard")
if ! echo "$LEADERBOARD_HTML" | grep -qF "$CONTESTANT_LOGIN"; then
  echo "FAIL: /leaderboard has no row for $CONTESTANT_LOGIN — a contestant whose" >&2
  echo "      only points are ai points did not get a row created at all." >&2
  exit 1
fi

# The formatted TOTAL, matched across the whole page rather than inside a
# window around the login — see acceptance-classic-only.sh's identical
# assertion for why a bounded-window regex is never used here (it held
# locally and broke in CI once before). A whole-page match is safe because
# the expected string carries a thousands separator ("4,321"), which nothing
# else on the page can coincidentally produce, and CONTESTANT_POINTS is
# deliberately chosen to differ from the seeded challenge's own price.
if ! echo "$LEADERBOARD_HTML" | grep -qF "$CONTESTANT_POINTS_FORMATTED"; then
  echo "FAIL: /leaderboard shows $CONTESTANT_LOGIN but not their ai total" >&2
  echo "      ($CONTESTANT_POINTS_FORMATTED) — the row exists, so the module" >&2
  echo "      overlay ran, but the points did not reach it." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# The ai-specific check no sibling module has: the public launch-key
# endpoint. No OAuth app exists in CI and this route is deliberately
# unauthenticated (ADR 53), so there is nothing to seed here — the box mints
# its module-wide Ed25519 keypair lazily on first read (getAiLaunchKeys in
# ai-store.ts) and this is the first thing in this script that ever reads it.
# ---------------------------------------------------------------------------
echo "--- GET /api/ai/launch-key 200s with an Ed25519 PEM public key"
LAUNCH_KEY_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/api/ai/launch-key")
[ "$LAUNCH_KEY_CODE" = "200" ] || {
  echo "FAIL: /api/ai/launch-key returned $LAUNCH_KEY_CODE, want 200"
  docker logs ao-app 2>&1 | tail -80
  exit 1
}
LAUNCH_KEY_BODY=$(curl -sf "$APP_URL/api/ai/launch-key")
if ! echo "$LAUNCH_KEY_BODY" | grep -qF '"alg":"Ed25519"'; then
  echo "FAIL: /api/ai/launch-key did not report alg:Ed25519 — got: $LAUNCH_KEY_BODY" >&2
  exit 1
fi
if ! echo "$LAUNCH_KEY_BODY" | grep -qF 'BEGIN PUBLIC KEY'; then
  echo "FAIL: /api/ai/launch-key did not include a PEM public key — got: $LAUNCH_KEY_BODY" >&2
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

echo "ACCEPTANCE PASS (ai-only event)"
