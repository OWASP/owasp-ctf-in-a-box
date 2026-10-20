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
acc_write_sync_override "$SYNC_OVERRIDE"

SYNC_PROJECT=ctf-quiz-only-sync-acceptance

cleanup() {
  docker rm -f qo-app qo-redis qo-srh >/dev/null 2>&1 || true
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
acc_assert_module_lineups quiz

# ---------------------------------------------------------------------------
# redis + srh (the exact images/config docker-compose.yml pins), on a private
# network. No scorer: a quiz-only event never resolves to a scored
# leaderboard source, so there is nothing here for it to serve.
# ---------------------------------------------------------------------------
acc_boot_redis_srh "$NET" qo "$SRH_TOKEN"

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

acc_boot_app qo-app "$APP_PORT" ctf-web:quiz-only-acceptance "$NET" \
  http://srh:80 "$SRH_TOKEN" "$APP_GITHUB_ORG" "$APP_ADMIN_LOGINS" \
  quiz-only-acceptance-secret-32-characters-min

APP_URL="http://localhost:$APP_PORT"
echo "--- before launch, /quiz redirects to the landing page (#464)"
acc_wait_http "$APP_URL" 90 / || {
  echo "FAIL: the landing page never returned 200"
  docker logs qo-app 2>&1 | tail -80
  exit 1
}
acc_assert_prelaunch_redirect "$APP_URL" /quiz || exit 1
echo "--- launch the event (the field /admin's Launch writes)"
acc_launch qo-redis

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

# The row-by-login + formatted-total assertion (the anti-vacuous overlay check
# the header describes) is shared with the classic/ai gates — its whole-page
# match rationale lives with acc_assert_leaderboard_contrib.
acc_assert_leaderboard_contrib "$APP_URL" quiz "$CONTESTANT_LOGIN" "$CONTESTANT_POINTS_FORMATTED"

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
# come up and poll nothing. The whole check is shared with the classic/ai
# gates (acc_assert_sync_refuses_no_org), which assert the same refusal.
# ---------------------------------------------------------------------------
acc_assert_sync_refuses_no_org "$SYNC_PROJECT" "$SYNC_OVERRIDE"

echo "ACCEPTANCE PASS (quiz-only event)"
