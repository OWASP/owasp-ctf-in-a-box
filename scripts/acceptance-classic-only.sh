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
#     gated on isModuleLive("secure-development") in
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
acc_write_sync_override "$SYNC_OVERRIDE"

SYNC_PROJECT=ctf-classic-only-sync-acceptance

cleanup() {
  docker rm -f co-app co-redis co-srh >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  acc_sync_compose "$SYNC_PROJECT" "$SYNC_OVERRIDE" down -v --remove-orphans >/dev/null 2>&1 || true
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
acc_assert_module_lineups classic

# ---------------------------------------------------------------------------
# redis + srh (the exact images/config docker-compose.yml pins), on a private
# network. No scorer: a classic-only event never resolves to a scored
# leaderboard source, so there is nothing here for it to serve.
# ---------------------------------------------------------------------------
acc_boot_redis_srh "$NET" co "$SRH_TOKEN"

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

acc_boot_app co-app "$APP_PORT" ctf-web:classic-only-acceptance "$NET" \
  http://srh:80 "$SRH_TOKEN" "$APP_GITHUB_ORG" "$APP_ADMIN_LOGINS" \
  classic-only-acceptance-secret-32-characters-min

APP_URL="http://localhost:$APP_PORT"
echo "--- before launch, /flags redirects to the landing page (#464)"
acc_wait_http "$APP_URL" 90 / || {
  echo "FAIL: the landing page never returned 200"
  docker logs co-app 2>&1 | tail -80
  exit 1
}
acc_assert_prelaunch_redirect "$APP_URL" /flags || exit 1
echo "--- launch the event (the field /admin's Launch writes)"
acc_launch co-redis

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

# The row-by-login + formatted-total assertion (the anti-vacuous overlay check
# the header describes) is shared with the quiz/ai gates — its whole-page
# match rationale (and the bounded-window regex that broke in CI once) lives
# with acc_assert_leaderboard_contrib.
acc_assert_leaderboard_contrib "$APP_URL" classic "$CONTESTANT_LOGIN" "$CONTESTANT_POINTS_FORMATTED"

# ---------------------------------------------------------------------------
# sync: through the real docker-compose.yml (see header comment for why),
# overriding only GITHUB_ORG and the restart policy. With no org it must
# REFUSE at start-up — naming the key, with a non-zero exit — rather than
# come up and poll nothing. The whole check is shared with the quiz/ai gates
# (acc_assert_sync_refuses_no_org), which assert the same refusal.
# ---------------------------------------------------------------------------
acc_assert_sync_refuses_no_org "$SYNC_PROJECT" "$SYNC_OVERRIDE"

echo "ACCEPTANCE PASS (classic-only event)"
