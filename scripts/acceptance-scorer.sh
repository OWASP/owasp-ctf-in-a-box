#!/usr/bin/env bash
# Offline e2e for the in-repo scorer engine (scorer/): build the image pinned
# to the example rubric (rubric.example — the stock build now bakes the
# vendored rubric.owasp by default), boot `score serve` + a tiny fake target
# app, then run the judge entrypoint exactly the way the consumer workflow /
# score-action does (entrypoint override, docker.sock, workspace + event.json
# mounts).
#
# TARGET is "juice-shop" (rubric.example's example target), and rubric.owasp's
# real juice-shop entrypoint script (scorer/entrypoints/juice-shop.sh) is
# always baked into every scorer image regardless of which rubric directory
# is baked — so entrypoint.sh always sources it for TARGET=juice-shop. That
# script has no "assume APP_URL already up" fallback: it requires APP_IMAGE
# or a workspace Dockerfile. The fake app is therefore delivered via a
# workspace Dockerfile (write_fake_app below) rather than booted directly —
# which is also, per that script's own comment, the normal case for real
# Juice Shop scoring (a PR fork's root Dockerfile), so this exercises the
# real path rather than working around it.
#
# The fake app deliberately PASSES two example-rubric challenges and FAILS one,
# so the asserted "2 / 3" count proves the probes actually discriminate — an
# all-pass or all-fail app could green-light a judge that ignores its rubric.
# A second, "stock" fake app then fails EVERY probe (unpatched behaviour) and
# the asserted "0 / 3" plus its absence from the leaderboard proves the
# stock-scores-zero invariant (docs/modules.md §6.4) mechanically.
#
# Asserts, against the real artifacts (no mocks on the scorer side):
#   - ctf-score.md carries the two score-action regexes verbatim
#     (title line + "**N / M** challenges patched") with the expected N/M
#   - oracle discipline: no probe path/expect string from the rubric leaks
#   - the sync marker parses via the REAL sync/src/parse.js import
#   - the poll transport end to end: the marker this judge wrote, POSTed to
#     the scorer the way sync does, makes GET /leaderboard show rubric-derived
#     points and totals
# Needs Docker only; the sole network access is pulling node:22-alpine.
set -euo pipefail
cd "$(dirname "$0")/.."

# pins: the scorer image acc_build_scorer builds from this checkout
IMG=ctf-score:acceptance
NET=ctf-scorer-acceptance
SERVE_CTR=ctf-scorer-acceptance-serve
# Network aliases the fake app answers under, one per judge run below. Each
# run's own entrypoint invocation builds and boots its own app container
# (named ctf-app-juice-shop, from the workspace Dockerfile) and registers it
# under one of these aliases — nothing here names a container directly.
APP_CTR=ctf-scorer-acceptance-app
STOCK_CTR=ctf-scorer-acceptance-stock
SERVE_PORT=4102
# Freeze stage (organizer pause): a second serve instance backed by
# real Redis (via SRH), so the assertion below exercises isPaused()'s actual
# HGET path rather than only the memory-store test seam node --test already
# covers. Declared up front so cleanup()'s `set -u` reference is always valid,
# even if the script exits before this stage runs.
FREEZE_REDIS_CTR=ctf-scorer-acceptance-redis
FREEZE_SRH_CTR=ctf-scorer-acceptance-srh
FREEZE_SERVE_CTR=ctf-scorer-acceptance-serve-freeze
FREEZE_SRH_TOKEN=freeze-srh-token
FREEZE_PORT=4103
TMP=$(mktemp -d /tmp/ctf-scorer-acceptance.XXXXXX)
WS_PATCHED="$TMP/workspace-patched"
WS_STOCK="$TMP/workspace-stock"
mkdir -p "$WS_PATCHED" "$WS_STOCK"

# Writes a workspace Dockerfile + app.js so juice-shop.sh's PR-patch path
# (build a Dockerfile found at GITHUB_WORKSPACE) boots this fake app.
write_fake_app() {
  dir="$1"
  js="$2"
  printf '%s\n' "$js" > "$dir/app.js"
  cat > "$dir/Dockerfile" <<'DOCKER'
FROM node:22-alpine
WORKDIR /app
COPY app.js .
CMD ["node", "app.js"]
DOCKER
}

cleanup() {
  docker rm -f "$SERVE_CTR" ctf-app-juice-shop \
    "$FREEZE_SERVE_CTR" "$FREEZE_SRH_CTR" "$FREEZE_REDIS_CTR" >/dev/null 2>&1 || true
  docker rmi ctf-app-under-test >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker rmi "$IMG" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# Fabricated pull_request webhook payload — the judge reads author/pr/sha
# from it (readEvent), exactly what Actions mounts at /github/event.json.
cat > "$TMP/event.json" <<'JSON'
{ "pull_request": { "number": 7, "user": { "login": "octocat" }, "head": { "sha": "deadbeefcafe" } } }
JSON

# Fake target app, judged against scorer/rubric.example/juice-shop.yaml:
#   reflected-xss-search  PASS (200, payload not echoed back)
#   sqli-login-bypass     PASS (login answers 401)
#   confidential-ftp-doc  FAIL (still serves the document with a 200)
APP_JS=$(cat <<'JS'
require("node:http").createServer((req, res) => {
  const url = req.url || "";
  if (url.startsWith("/rest/products/search")) { res.writeHead(200); res.end("[]"); return; }
  if (url === "/rest/user/login") { res.writeHead(401); res.end("Invalid credentials"); return; }
  if (url === "/ftp/acquisitions.md") { res.writeHead(200); res.end("unpatched: still serving acquisitions"); return; }
  res.writeHead(200); res.end("ok");
}).listen(3000, () => console.error("fake target app on :3000"));
JS
)

write_fake_app "$WS_PATCHED" "$APP_JS"

echo "--- build scorer image (pinned to the example rubric)"
docker build -t "$IMG" --build-arg RUBRIC_DIR=rubric.example scorer/

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

echo "--- boot score serve (memory store)"
# pins: $IMG is the scorer image this script builds
docker run -d --name "$SERVE_CTR" --network "$NET" \
  -p "127.0.0.1:$SERVE_PORT:4000" -e SCORER_TOKEN=test-token "$IMG" >/dev/null

deadline=$((SECONDS + 60))
until curl -sf "http://127.0.0.1:$SERVE_PORT/healthz" >/dev/null 2>&1; do
  [ "$SECONDS" -ge "$deadline" ] && { echo "FAIL: score serve never came up"; exit 1; }
  sleep 1
done

# What sync does in production, inlined: read the `<!-- ctf-score: {...} -->`
# marker out of a report with the REAL sync parser and POST it to the scorer
# with the bearer token. Push ingest used to have the judge make this POST
# itself; that hook is removed (#377), so the score reaches the leaderboard
# the one way it now can, and this script exercises that path rather than
# asserting around it.
post_marker() {
  local report="$1" body code
  body="$(node -e '
const { readFileSync } = require("node:fs");
import("./sync/src/parse.js").then(({ parseScoreComment }) => {
  const r = parseScoreComment(readFileSync(process.argv[1], "utf8"), { targets: ["juice-shop"] });
  if (!r) { console.error("FAIL: marker did not parse"); process.exit(1); }
  process.stdout.write(JSON.stringify(r));
}).catch((e) => { console.error(e); process.exit(1); });
' "$report")" || { echo "FAIL: could not read the marker from $report"; exit 1; }
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$SERVE_PORT/score" \
    -H "authorization: Bearer test-token" -H 'content-type: application/json' -d "$body")"
  [ "$code" = "202" ] || { echo "FAIL: POST /score for $report returned $code"; exit 1; }
}

echo "--- run judge via the score-action contract"
# No --network on purpose: score-action starts the scorer on the default
# bridge and the entrypoint must self-attach to $NET over docker.sock.
# pins: $IMG is the scorer image this script builds
docker run --rm \
  --entrypoint /usr/local/bin/entrypoint.sh \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$WS_PATCHED:/github/workspace" \
  -v "$TMP/event.json:/github/event.json:ro" \
  -e TARGET=juice-shop \
  -e APP_URL="http://$APP_CTR:3000" \
  -e NETWORK="$NET" \
  -e GITHUB_WORKSPACE=/github/workspace \
  -e GITHUB_EVENT_PATH=/github/event.json \
  -e APP_READY_TRIES=15 -e APP_READY_DELAY=1 \
  "$IMG"

# entrypoint.sh ends every path in `exec score judge`, which replaces the
# shell's process image — its own EXIT trap (meant to remove the app
# container it booted) never runs, because exec never returns to fire it.
# acceptance-target.sh works around this the same way: the app container
# (a fixed name derived from TARGET) must be reaped here, externally,
# before the next run reuses that same name.
docker rm -f ctf-app-juice-shop >/dev/null 2>&1 || true

REPORT="$WS_PATCHED/ctf-score.md"
[ -f "$REPORT" ] || { echo "FAIL: judge wrote no ctf-score.md"; exit 1; }

echo "--- report carries the score-action regexes with the expected count"
grep -qF '## 🏆 CTF Patch Score' "$REPORT" \
  || { echo "FAIL: ctf-score.md has no '## 🏆 CTF Patch Score' heading"; cat "$REPORT"; exit 1; }
grep -qF '**2 / 3** challenges patched' "$REPORT" \
  || { echo "FAIL: ctf-score.md does not say '**2 / 3** challenges patched'"; cat "$REPORT"; exit 1; }

echo "--- oracle discipline: no probe internals leak into the comment"
for secret in '/rest/products/search' 'alert(1)' '/rest/user/login' '/ftp/acquisitions.md' 'bodyMissing'; do
  if grep -qF "$secret" "$REPORT"; then
    echo "FAIL: probe internal '$secret' leaked into ctf-score.md"; exit 1
  fi
done

echo "--- sync marker parses via the real sync/src/parse.js"
node -e '
const { readFileSync } = require("node:fs");
import("./sync/src/parse.js").then(({ parseScoreComment }) => {
  const body = readFileSync(process.argv[1], "utf8");
  const r = parseScoreComment(body, { targets: ["juice-shop"] });
  if (!r) { console.error("FAIL: marker did not parse"); process.exit(1); }
  const solved = [...r.solved].sort().join(",");
  if (r.author !== "octocat" || r.target !== "juice-shop" || r.pr !== 7 ||
      r.sha !== "deadbeefcafe" || solved !== "reflected-xss-search,sqli-login-bypass") {
    console.error("FAIL: unexpected parse result: " + JSON.stringify(r)); process.exit(1);
  }
  console.log("marker ok: " + JSON.stringify(r));
}).catch((e) => { console.error(e); process.exit(1); });
' "$REPORT"

echo "--- poll transport: POST the marker to the scorer the way sync does"
post_marker "$REPORT"

echo "--- leaderboard shows octocat with rubric-derived points/totals"
curl -sf "http://127.0.0.1:$SERVE_PORT/leaderboard" | node -e '
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", () => {
  const { leaderboard } = JSON.parse(s);
  const e = leaderboard && leaderboard[0];
  if (!e || leaderboard.length !== 1 || e.rank !== 1 || e.author !== "octocat" ||
      e.points !== 20 ||
      !e.apps || !e.apps["juice-shop"] ||
      e.apps["juice-shop"].solved !== 2 || e.apps["juice-shop"].total !== 3) {
    console.error("FAIL: unexpected leaderboard: " + s); process.exit(1);
  }
  console.log("leaderboard ok: " + s);
});
'

echo "--- stock-scores-zero (modules.md 6.4): judge an unpatched fake app"
# Second webhook payload: a different author, so the leaderboard check below
# can prove the stock run recorded nothing for them specifically.
cat > "$TMP/event-stock.json" <<'JSON'
{ "pull_request": { "number": 8, "user": { "login": "mallory" }, "head": { "sha": "0000000000ck" } } }
JSON

# "Stock" fake app: hits every example-rubric probe's FAIL branch —
#   reflected-xss-search  FAIL (200 but the payload is echoed back verbatim)
#   sqli-login-bypass     FAIL (200 + token: the SQLi bypass still logs in)
#   confidential-ftp-doc  FAIL (200: the document is still served)
STOCK_APP_JS=$(cat <<'JS'
require("node:http").createServer((req, res) => {
  const url = req.url || "";
  if (url.startsWith("/rest/products/search")) { res.writeHead(200); res.end("<h1>Results for <script>alert(1)</script></h1>"); return; }
  if (url === "/rest/user/login") { res.writeHead(200); res.end('{"authentication":{"token":"stock-jwt"}}'); return; }
  if (url === "/ftp/acquisitions.md") { res.writeHead(200); res.end("top secret acquisitions"); return; }
  res.writeHead(200); res.end("ok");
}).listen(3000, () => console.error("stock fake app on :3000"));
JS
)
write_fake_app "$WS_STOCK" "$STOCK_APP_JS"

# pins: $IMG is the scorer image this script builds
docker run --rm \
  --entrypoint /usr/local/bin/entrypoint.sh \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$WS_STOCK:/github/workspace" \
  -v "$TMP/event-stock.json:/github/event.json:ro" \
  -e TARGET=juice-shop \
  -e APP_URL="http://$STOCK_CTR:3000" \
  -e NETWORK="$NET" \
  -e GITHUB_WORKSPACE=/github/workspace \
  -e GITHUB_EVENT_PATH=/github/event.json \
  -e APP_READY_TRIES=15 -e APP_READY_DELAY=1 \
  "$IMG"

docker rm -f ctf-app-juice-shop >/dev/null 2>&1 || true

STOCK_REPORT="$WS_STOCK/ctf-score.md"
[ -f "$STOCK_REPORT" ] || { echo "FAIL: stock judge wrote no ctf-score.md"; exit 1; }
grep -qF '**0 / 3** challenges patched' "$STOCK_REPORT" \
  || { echo "FAIL: stock ctf-score.md does not say '**0 / 3** challenges patched'"; cat "$STOCK_REPORT"; exit 1; }
# An empty solve list is a real result, not a failure to report: the scorer
# takes it (202) and the author stays at zero.
post_marker "$STOCK_REPORT"

echo "--- leaderboard: the stock author gained nothing (zero/absent entry)"
curl -sf "http://127.0.0.1:$SERVE_PORT/leaderboard" | node -e '
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", () => {
  const { leaderboard } = JSON.parse(s);
  const mallory = leaderboard.find((e) => e.author === "mallory");
  if (mallory && (mallory.points !== 0 || mallory.apps["juice-shop"].solved !== 0)) {
    console.error("FAIL: stock target handed out points: " + s); process.exit(1);
  }
  if (leaderboard.length !== 1 || leaderboard[0].author !== "octocat") {
    console.error("FAIL: unexpected leaderboard after stock run: " + s); process.exit(1);
  }
  console.log("stock-zero ok: " + s);
});
'

echo "--- freeze: boot a second serve instance backed by real Redis (via SRH)"
docker run -d --name "$FREEZE_REDIS_CTR" --network "$NET" redis:8-alpine@sha256:becdda6c7f4b3fb42e42fd7f120bbf5c54c4caaaf16f26da24e4563d2c1f0576 >/dev/null
docker run -d --name "$FREEZE_SRH_CTR" --network "$NET" \
  -e SRH_MODE=env -e SRH_TOKEN="$FREEZE_SRH_TOKEN" \
  -e SRH_CONNECTION_STRING="redis://$FREEZE_REDIS_CTR:6379" \
  hiett/serverless-redis-http:latest@sha256:5b0bb9239fce53abf87b2018a7a0deb9ec7bd900c5360738fe5fbeeb426f9150 >/dev/null

srh_deadline=$((SECONDS + 30))
until docker exec "$FREEZE_SRH_CTR" wget -qO- \
  --header="Authorization: Bearer $FREEZE_SRH_TOKEN" --header='Content-Type: application/json' \
  --post-data='["PING"]' http://127.0.0.1:80/ 2>/dev/null | grep -q PONG; do
  [ "$SECONDS" -ge "$srh_deadline" ] && { echo "FAIL: srh never came up for freeze stage"; exit 1; }
  sleep 1
done

# pins: $IMG is the scorer image this script builds
docker run -d --name "$FREEZE_SERVE_CTR" --network "$NET" \
  -p "127.0.0.1:$FREEZE_PORT:4000" \
  -e SCORER_TOKEN=test-token \
  -e UPSTASH_REDIS_REST_URL="http://$FREEZE_SRH_CTR:80" \
  -e UPSTASH_REDIS_REST_TOKEN="$FREEZE_SRH_TOKEN" \
  "$IMG" >/dev/null

deadline=$((SECONDS + 60))
until curl -sf "http://127.0.0.1:$FREEZE_PORT/healthz" >/dev/null 2>&1; do
  [ "$SECONDS" -ge "$deadline" ] && { echo "FAIL: freeze-mode score serve never came up"; exit 1; }
  sleep 1
done

score_freeze() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$FREEZE_PORT/score" \
    -H "authorization: Bearer test-token" -H 'content-type: application/json' \
    -d '{"author":"octocat","target":"juice-shop","solved":["reflected-xss-search"]}'
}

echo "--- freeze: an unlaunched event (no scoringStartsAt) rejects POST /score with 503"
# #464: no scoring start = not launched = scoring closed, in every reader.
# The launch below is what makes the 202 after the freeze clears meaningful.
code=$(score_freeze)
[ "$code" = "503" ] || { echo "FAIL: expected 503 before launch (scoringStartsAt unset), got $code"; exit 1; }

echo "--- freeze: launch (write scoringStartsAt) for the freeze checks below"
docker exec "$FREEZE_REDIS_CTR" redis-cli HSET ctf:admin:settings scoringStartsAt "2000-01-01T00:00:00Z" >/dev/null

echo "--- freeze: ctf:admin:settings paused=1 rejects POST /score with 503"
docker exec "$FREEZE_REDIS_CTR" redis-cli HSET ctf:admin:settings paused 1 >/dev/null
code=$(score_freeze)
[ "$code" = "503" ] || { echo "FAIL: expected 503 while paused, got $code"; exit 1; }

echo "--- freeze: clearing paused resumes normal scoring"
docker exec "$FREEZE_REDIS_CTR" redis-cli HSET ctf:admin:settings paused 0 >/dev/null
code=$(score_freeze)
[ "$code" = "202" ] || { echo "FAIL: expected 202 after resume, got $code"; exit 1; }

# A score sent with `at` (the score comment's time, which sync sends) is timed
# by it and judged AT it: the launch, the freeze and the reset epoch as they
# stood then, read from the settings hash and the pause log over srh (ADR 67).
# The checks above send no `at`, the older sync's arrival-time path.
score_at() { # $1 = author, $2 = at
  curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$FREEZE_PORT/score" \
    -H "authorization: Bearer test-token" -H 'content-type: application/json' \
    -d "{\"author\":\"$1\",\"target\":\"juice-shop\",\"solved\":[\"reflected-xss-search\"],\"at\":\"$2\"}"
}
expect_code() { # $1 = expected, $2 = actual, $3 = what
  [ "$2" = "$1" ] || { echo "FAIL: $3: expected $1, got $2"; exit 1; }
}
redis_freeze() { docker exec "$FREEZE_REDIS_CTR" redis-cli "$@" >/dev/null; }

echo "--- comment time: a score posted before the launch is refused for good (422)"
expect_code 422 "$(score_at before-launch 1999-12-31T23:59:59Z)" "a score posted before scoringStartsAt"

echo "--- comment time: recorded at the comment's time, not at arrival"
expect_code 202 "$(score_at early-bird 2001-02-03T04:05:06Z)" "a score posted during play"
curl -sf "http://127.0.0.1:$FREEZE_PORT/leaderboard" | grep -q '"author":"early-bird","points":[0-9]*,"lastSolveAt":"2001-02-03T04:05:06.000Z"' \
  || { echo "FAIL: early-bird's solve was not timed by its comment"; exit 1; }

echo "--- comment time: frozen since T, a score from before T scores and one from T on is refused"
redis_freeze HSET ctf:admin:settings paused 1 pausedSince 2020-01-01T00:00:00.000Z
expect_code 202 "$(score_at before-freeze 2019-12-31T23:59:59Z)" "a score posted before the freeze, read during it"
expect_code 422 "$(score_at in-freeze 2020-01-01T00:00:00Z)" "a score posted at the freeze's start"

echo "--- comment time: once lifted, the logged interval still refuses, and after it scores"
redis_freeze HDEL ctf:admin:settings paused pausedSince
redis_freeze LPUSH ctf:admin:pauses '{"from":"2020-01-01T00:00:00.000Z","to":"2020-01-02T00:00:00.000Z"}'
expect_code 422 "$(score_at in-logged-freeze 2020-01-01T12:00:00Z)" "a score posted inside a logged freeze"
expect_code 202 "$(score_at after-freeze 2020-01-02T00:00:00Z)" "a score posted as the freeze lifted"

echo "--- comment time: a freeze with no recorded start answers 503 (retry), not a final refusal"
redis_freeze HSET ctf:admin:settings paused 1
expect_code 503 "$(score_at unknown-start 2021-01-01T00:00:00Z)" "a score under a freeze with no pausedSince"
redis_freeze HDEL ctf:admin:settings paused

echo "--- comment time: a score older than the master-reset epoch is refused (422)"
redis_freeze HSET ctf:admin:settings resetAt 1640995200000
expect_code 422 "$(score_at pre-reset 2021-06-01T00:00:00Z)" "a score posted before the reset epoch"
expect_code 202 "$(score_at post-reset 2022-06-01T00:00:00Z)" "a score posted after the reset epoch"

echo "ACCEPTANCE PASS"
