#!/usr/bin/env bash
# Offline e2e: mock-github -> sync -> mock-scorer -> leaderboard.
# Proves the poll pipeline (trust filter included) with zero external services.
# The scorer here is a stand-in that records what it is sent; the real
# scorer's judgment of a score's time (window, freeze, reset) is gated by
# acceptance-scorer.sh against a real Redis.
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
pong="$(compose exec -T redis redis-cli ping 2>&1 || true)"
grep -qx PONG <<< "$pong" || { echo "FAIL: redis did not answer PING with PONG: $pong"; exit 1; }

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

echo "--- unlaunched event: the sync heartbeat reports scoring as paused"
# No scoringStartsAt on a fresh box means "not launched" (ADR 59). The poller
# reports it, but does not hold its cursor for it: every score goes to the
# scorer with its comment's own time, and the scorer refuses one posted
# before the launch, during a freeze or after the end (ADR 67). That judgment
# is the real scorer's and is gated against a real Redis by
# acceptance-scorer.sh; this profile runs a stand-in that records what it is
# sent, so what is checked here is the poller's half.
# 30s, like the ingest wait: a tick that started while srh was still booting
# can sit in two 10s pipeline timeouts (isPaused + writeStatus) first.
prelaunch_deadline=$((SECONDS + 30))
until compose exec -T redis redis-cli HGET ctf:sync:status paused 2>/dev/null | grep -q '^1$'; do
  [ "$SECONDS" -ge "$prelaunch_deadline" ] && { echo "FAIL: sync heartbeat never reported paused before launch"; compose logs sync; exit 1; }
  sleep 1
done

echo "--- launch: write scoringStartsAt"
# The app isn't in this profile, so write the field /admin's Launch writes
# straight onto the settings hash the poller reads.
launched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
compose exec -T redis redis-cli HSET ctf:admin:settings scoringStartsAt "$launched_at" >/dev/null
launch_deadline=$((SECONDS + 15))
until compose exec -T redis redis-cli HGET ctf:sync:status paused 2>/dev/null | grep -q '^0$'; do
  [ "$SECONDS" -ge "$launch_deadline" ] && { echo "FAIL: sync heartbeat never reported live after the launch"; compose logs sync; exit 1; }
  sleep 1
done

echo "--- sync ingests fixture comments (waiting up to 30s)"
deadline=$((SECONDS + 30))
until curl -sf http://localhost:4000/leaderboard | grep -q '"octocat"'; do
  [ "$SECONDS" -ge "$deadline" ] && { echo "FAIL: octocat never appeared"; compose logs sync; exit 1; }
  sleep 2
done

board=$(curl -sf http://localhost:4000/leaderboard)
echo "$board"

echo "--- scores match fixtures (1 point per solved id)"
# Here-strings, not `echo | grep -q`: under pipefail a large board can lose
# the SIGPIPE race and fail on a line that matched.
grep -qF '"author":"octocat","points":2' <<< "$board" \
  || { echo "FAIL: leaderboard has no octocat at 2 points"; exit 1; }
grep -qF '"author":"mona","points":1' <<< "$board" \
  || { echo "FAIL: leaderboard has no mona at 1 point"; exit 1; }

echo "--- each score carries its own comment's time, not the time it was read"
grep -q '"author":"octocat","points":2,"solved":\[[^]]*\],"at":"2026-08-13T10:00:00Z"' <<< "$board" \
  || { echo "FAIL: octocat's score did not carry its comment's updated_at"; exit 1; }
grep -q '"author":"mona","points":1,"solved":\[[^]]*\],"at":"2026-08-13T10:10:00Z"' <<< "$board" \
  || { echo "FAIL: mona's score did not carry its comment's updated_at"; exit 1; }

echo "--- forged comment from mallory was ignored (trust filter)"
if grep -qF '"author":"mallory"' <<< "$board"; then
  echo "FAIL: forged comment was scored"; exit 1
fi

echo "--- unauthenticated POST /score rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:4000/score \
  -H 'content-type: application/json' -d '{"author":"evil","target":"dvwa","solved":["x"]}')
[ "$code" = "401" ] || { echo "FAIL: unauthenticated POST /score answered $code, not 401"; exit 1; }

echo "--- organizer freeze: the poller reports it and keeps reading"
# The app isn't in this smoke profile (only redis/srh/scorer/mock-github/sync
# are brought up), so there's no /api/admin/settings route to call here.
# Set the pause flag straight on the same ctf:admin:settings hash the sync
# poller reads (sync/src/redis.js isPaused()).
compose exec -T redis redis-cli HSET ctf:admin:settings paused 1 >/dev/null

echo "--- sync heartbeat reports paused (waiting up to 15s)"
pause_deadline=$((SECONDS + 15))
until compose exec -T redis redis-cli HGET ctf:sync:status paused 2>/dev/null | grep -q '^1$'; do
  [ "$SECONDS" -ge "$pause_deadline" ] && { echo "FAIL: sync never reported paused"; compose logs sync; exit 1; }
  sleep 1
done

# Queue a fresh score comment behind the flag: mock-github serves it only
# once this marker file exists (test/fixtures/mock-github.mjs), simulating a
# contributor's PR getting scored while the organizer has frozen scoring.
compose exec -T mock-github touch /tmp/extra-comment >/dev/null

echo "--- a frozen poller still forwards the queued score, with its comment's time (waiting up to 15s)"
# Holding the cursor would score a comment posted during the freeze once it
# lifts, and delay one posted before it; the scorer decides on the comment's
# time instead, so the poller hands it over now.
frozen_deadline=$((SECONDS + 15))
until curl -sf http://localhost:4000/leaderboard | grep -q '"trinity"'; do
  [ "$SECONDS" -ge "$frozen_deadline" ] && { echo "FAIL: the poller held trinity's score during the freeze"; compose logs sync; exit 1; }
  sleep 1
done
curl -sf http://localhost:4000/leaderboard | grep -q '"author":"trinity","points":1,"solved":\["dvwa:csrf-low"\],"at":"2026-08-13T10:15:00Z"' \
  || { echo "FAIL: trinity's score did not match the queued fixture and its comment time"; exit 1; }
compose exec -T redis redis-cli HGET ctf:sync:status paused 2>/dev/null | grep -q '^1$' \
  || { echo "FAIL: ctf:sync:status paused was not 1 while frozen"; exit 1; }

echo "--- clearing the freeze: the heartbeat reports live again"
compose exec -T redis redis-cli HDEL ctf:admin:settings paused >/dev/null
resume_deadline=$((SECONDS + 15))
until compose exec -T redis redis-cli HGET ctf:sync:status paused 2>/dev/null | grep -q '^0$'; do
  [ "$SECONDS" -ge "$resume_deadline" ] && { echo "FAIL: ctf:sync:status paused never returned to 0"; compose logs sync; exit 1; }
  sleep 1
done

# The scheduled scoring window (admin "auto dates") must read as paused the
# same way the manual toggle does — the poller's isPaused() honors both. Set a
# scoringEndsAt in the past directly on the hash the poller reads
# (sync/src/redis.js), same read path as the dashboard's write.
echo "--- scheduled scoring window (past end) reports paused"
compose exec -T redis redis-cli HSET ctf:admin:settings scoringEndsAt "2000-01-01T00:00:00.000Z" >/dev/null
win_deadline=$((SECONDS + 15))
until compose exec -T redis redis-cli HGET ctf:sync:status paused 2>/dev/null | grep -q '^1$'; do
  [ "$SECONDS" -ge "$win_deadline" ] && { echo "FAIL: scheduled window did not pause the poller"; compose logs sync; exit 1; }
  sleep 1
done

echo "--- clearing the window reports live again"
compose exec -T redis redis-cli HDEL ctf:admin:settings scoringEndsAt >/dev/null
resume2_deadline=$((SECONDS + 15))
until compose exec -T redis redis-cli HGET ctf:sync:status paused 2>/dev/null | grep -q '^0$'; do
  [ "$SECONDS" -ge "$resume2_deadline" ] && { echo "FAIL: poller did not resume after clearing the window"; compose logs sync; exit 1; }
  sleep 1
done

echo "SMOKE PASS"
