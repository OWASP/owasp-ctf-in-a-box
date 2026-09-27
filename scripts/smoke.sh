#!/usr/bin/env bash
# Offline e2e: mock-github -> sync -> mock-scorer -> leaderboard.
# Proves the poll pipeline (trust filter included) with zero external services.
set -euo pipefail
cd "$(dirname "$0")/.."

SMOKE_APP_KEY_B64="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null | base64 | tr -d '\n')"
export SRH_TOKEN=smoke-srh SCORER_TOKEN=smoke-scorer REDIS_PASSWORD=smoke-redis
export GITHUB_APP_ID=1 GITHUB_APP_PRIVATE_KEY="$SMOKE_APP_KEY_B64" GITHUB_APP_INSTALLATION_ID=1
# The org the mock-github fixture serves score comments under, and the one
# key sync refuses to start without (config v2, #386 — the poller reads its
# whole config from the environment, there is no config file to mount any
# more). Which targets get polled is a runtime Redis read, so a fixture that
# covers dvwa + juice-shop needs nothing declared here.
export GITHUB_ORG=evt-org
# `--profile secdev` is what brings the scorer and sync up (config v2, #386:
# the profile is the secure-development module's, derived from a non-empty
# SCORE_IMAGE by whoever runs the real stack). The pipeline under test is the
# poll transport, which since #377 is the only one there is.
compose() { docker compose -f docker-compose.yml -f docker-compose.smoke.yml --profile secdev "$@"; }

cleanup() { compose down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

compose up -d --build redis srh scorer mock-github sync

echo "--- redis answers"
compose exec -T redis redis-cli ping | grep -q PONG

# The two halves of the Redis hardening, asserted rather than assumed. Both
# are the kind of control that looks present in a compose file and is absent
# in the running stack — a typo in the connection string, a service left on
# the wrong network, and everything still works because the fallback is
# "unauthenticated access succeeds".
echo "--- redis refuses unauthenticated commands"
# NOAUTH proves requirepass is live: same client as the PING above, minus the
# credential. `unset` inside the shell rather than `exec -e REDISCLI_AUTH=`,
# which is ambiguous — the service already defines that variable, and the
# empty override did not reliably clear it (redis-cli still attempted an
# AUTH). Unsetting in-container leaves no doubt about what was sent.
noauth="$(compose exec -T redis sh -c 'unset REDISCLI_AUTH; redis-cli PING' 2>&1 || true)"
case "$noauth" in
  *NOAUTH*|*"Authentication required"*) ;;
  *) echo "FAIL: redis answered an unauthenticated PING: $noauth"; exit 1 ;;
esac

echo "--- app-tier services have no route to redis at all"
# Network isolation, independent of the password: sync sits on `frontend`
# only, so redis:6379 must not even resolve for it. Tested from sync because
# it is the app-tier service this smoke profile already builds.
if compose run --rm --no-deps --entrypoint sh sync -c \
  "getent hosts redis >/dev/null 2>&1 && echo REACHABLE" 2>/dev/null | grep -q REACHABLE; then
  echo "FAIL: an app-tier service can still resolve redis — the network split is not in effect"; exit 1
fi

echo "--- srh proxies redis (upstash REST contract)"
compose exec -T redis redis-cli set smoke-key smoke-val >/dev/null
# hiett/serverless-redis-http (srh) does not implement upstash's path-style
# GET shortcut (GET /get/<key> returns 404) — only the body/command-array
# form the @upstash/redis SDK uses (POST / with a JSON array) is supported.
# srh's Erlang VM also takes a beat past "compose up" returning to bind its
# listener, so retry a few times instead of asserting on the first attempt.
srh_deadline=$((SECONDS + 15))
until compose run --rm --no-deps --entrypoint sh sync -c \
  "wget -qO- --header='Authorization: Bearer ${SRH_TOKEN}' --header='Content-Type: application/json' --post-data='[\"GET\",\"smoke-key\"]' http://srh:80/" \
  2>/dev/null | grep -q smoke-val; do
  [ "$SECONDS" -ge "$srh_deadline" ] && { echo "FAIL: srh never proxied redis"; compose logs srh; exit 1; }
  sleep 1
done

echo "--- unlaunched event: sync holds ingestion (holding 6s)"
# No scoringStartsAt on a fresh box means "not launched" (#464): the poller
# must not ingest anything. Anti-vacuous: the SAME fixtures do ingest right
# after the launch below, so an empty board here is the lock holding, not a
# poller that never works.
hold_until=$((SECONDS + 6))
while [ "$SECONDS" -lt "$hold_until" ]; do
  if curl -sf http://localhost:4000/leaderboard | grep -q '"octocat"'; then
    echo "FAIL: sync ingested scores before launch (scoringStartsAt unset)"; compose logs sync; exit 1
  fi
  sleep 2
done

echo "--- launch: write scoringStartsAt"
# The app isn't in this profile, so write the field /admin's Launch writes
# straight onto the settings hash the poller reads.
launched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
compose exec -T redis redis-cli HSET ctf:admin:settings scoringStartsAt "$launched_at" >/dev/null

echo "--- sync ingests fixture comments (waiting up to 30s)"
deadline=$((SECONDS + 30))
until curl -sf http://localhost:4000/leaderboard | grep -q '"octocat"'; do
  [ "$SECONDS" -ge "$deadline" ] && { echo "FAIL: octocat never appeared"; compose logs sync; exit 1; }
  sleep 2
done

board=$(curl -sf http://localhost:4000/leaderboard)
echo "$board"

echo "--- scores match fixtures (1 point per solved id)"
echo "$board" | grep -q '"author":"octocat","points":2'
echo "$board" | grep -q '"author":"mona","points":1'

echo "--- forged comment from mallory was ignored (trust filter)"
if echo "$board" | grep -q '"author":"mallory"'; then
  echo "FAIL: forged comment was scored"; exit 1
fi

echo "--- unauthenticated POST /score rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:4000/score \
  -H 'content-type: application/json' -d '{"author":"evil","target":"dvwa","solved":["x"]}')
[ "$code" = "401" ]

echo "--- organizer freeze holds ingestion (poll mode)"
# The app isn't in this smoke profile (only redis/srh/scorer/mock-github/sync
# are brought up), so there's no /api/admin/settings route to call here.
# Set the pause flag straight on the same ctf:admin:settings hash the sync
# poller reads (sync/src/redis.js isPaused()) — the write path differs from
# the dashboard's, but the read path the poller exercises is identical, so
# this genuinely proves the poll-mode freeze, not just a Redis fact.
compose exec -T redis redis-cli HSET ctf:admin:settings paused 1 >/dev/null

echo "--- sync heartbeat reports paused (waiting up to 15s)"
pause_deadline=$((SECONDS + 15))
until compose exec -T redis redis-cli HGET ctf:sync:status paused 2>/dev/null | grep -q '^1$'; do
  [ "$SECONDS" -ge "$pause_deadline" ] && { echo "FAIL: sync never reported paused"; compose logs sync; exit 1; }
  sleep 1
done

# Queue a fresh score comment behind the flag: mock-github serves it only
# once this marker file exists (test/fixtures/mock-github.mjs), simulating a
# contributor's PR getting scored while the organizer is holding ingestion.
compose exec -T mock-github touch /tmp/extra-comment >/dev/null

echo "--- paused poller does not ingest the queued score (holding 5s)"
sleep 5
board=$(curl -sf http://localhost:4000/leaderboard)
if echo "$board" | grep -q '"author":"trinity"'; then
  echo "FAIL: trinity was scored while paused"; exit 1
fi
compose exec -T redis redis-cli HGET ctf:sync:status paused 2>/dev/null | grep -q '^1$' \
  || { echo "FAIL: ctf:sync:status paused was not 1 after the hold"; exit 1; }

echo "--- clearing the freeze resumes ingestion"
compose exec -T redis redis-cli HDEL ctf:admin:settings paused >/dev/null

echo "--- queued score is ingested once unpaused (waiting up to 15s)"
resume_deadline=$((SECONDS + 15))
until curl -sf http://localhost:4000/leaderboard | grep -q '"trinity"'; do
  [ "$SECONDS" -ge "$resume_deadline" ] && { echo "FAIL: trinity never appeared after unpausing"; compose logs sync; exit 1; }
  sleep 1
done
curl -sf http://localhost:4000/leaderboard | grep -q '"author":"trinity","points":1' \
  || { echo "FAIL: trinity's score did not match the queued fixture"; exit 1; }
compose exec -T redis redis-cli HGET ctf:sync:status paused 2>/dev/null | grep -q '^0$' \
  || { echo "FAIL: ctf:sync:status paused was not 0 after resuming"; exit 1; }

# The scheduled scoring window (admin "auto dates") must freeze ingestion the
# same way the manual toggle does — the poller's isPaused() honors both. Set a
# scoringEndsAt in the past directly on the hash the poller reads
# (sync/src/redis.js), same read path as the dashboard's write.
echo "--- scheduled scoring window (past end) holds ingestion"
compose exec -T redis redis-cli HSET ctf:admin:settings scoringEndsAt "2000-01-01T00:00:00.000Z" >/dev/null
win_deadline=$((SECONDS + 15))
until compose exec -T redis redis-cli HGET ctf:sync:status paused 2>/dev/null | grep -q '^1$'; do
  [ "$SECONDS" -ge "$win_deadline" ] && { echo "FAIL: scheduled window did not pause the poller"; compose logs sync; exit 1; }
  sleep 1
done

echo "--- clearing the window resumes ingestion"
compose exec -T redis redis-cli HDEL ctf:admin:settings scoringEndsAt >/dev/null
resume2_deadline=$((SECONDS + 15))
until compose exec -T redis redis-cli HGET ctf:sync:status paused 2>/dev/null | grep -q '^0$'; do
  [ "$SECONDS" -ge "$resume2_deadline" ] && { echo "FAIL: poller did not resume after clearing the window"; compose logs sync; exit 1; }
  sleep 1
done

echo "SMOKE PASS"
