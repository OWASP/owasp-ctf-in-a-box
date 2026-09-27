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
#   - SCORE_API/SCORE_TOKEN in the judge's environment are inert (#377): the
#     judge itself posts nothing, so a leaderboard entry can only have come
#     from the POST this script makes
# Needs Docker only; the sole network access is pulling node:22-alpine.
set -euo pipefail
cd "$(dirname "$0")/.."

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
WS_POLL="$TMP/workspace-poll"
WS_STOCK="$TMP/workspace-stock"
mkdir -p "$WS_PATCHED" "$WS_POLL" "$WS_STOCK"

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
write_fake_app "$WS_POLL" "$APP_JS"

echo "--- build scorer image (pinned to the example rubric)"
docker build -t "$IMG" --build-arg RUBRIC_DIR=rubric.example scorer/

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

echo "--- boot score serve (memory store)"
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

echo "--- run judge via the score-action contract (SCORE_API set, and inert)"
# No --network on purpose: score-action starts the scorer on the default
# bridge and the entrypoint must self-attach to $NET over docker.sock.
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
  -e SCORE_API="http://$SERVE_CTR:4000" \
  -e SCORE_TOKEN=test-token \
  "$IMG"
# SCORE_API and SCORE_TOKEN above are deliberate DEAD environment: push ingest
# is removed (#377) and the judge has no POST hook left. They stay in this run
# so the leaderboard assertions below mean something - the entry can only come
# from post_marker, never from the judge, and if a hook ever came back the
# stage would double-post and the `solved !== 2` check would catch it.

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
grep -qF '## 🏆 CTF Patch Score' "$REPORT"
grep -qF '**2 / 3** challenges patched' "$REPORT"

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
grep -qF '**0 / 3** challenges patched' "$STOCK_REPORT"
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

echo "--- run judge again with no SCORE_API at all: the same report either way"
docker run --rm \
  --entrypoint /usr/local/bin/entrypoint.sh \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$WS_POLL:/github/workspace" \
  -v "$TMP/event.json:/github/event.json:ro" \
  -e TARGET=juice-shop \
  -e APP_URL="http://$APP_CTR:3000" \
  -e NETWORK="$NET" \
  -e GITHUB_WORKSPACE=/github/workspace \
  -e GITHUB_EVENT_PATH=/github/event.json \
  -e APP_READY_TRIES=15 -e APP_READY_DELAY=1 \
  "$IMG"

POLL_REPORT="$WS_POLL/ctf-score.md"
grep -qF '**2 / 3** challenges patched' "$POLL_REPORT"
grep -qF '<!-- ctf-score: ' "$POLL_REPORT"
# Byte-identical to the run that had SCORE_API set: the judge's output does not
# depend on that variable any more, which is the removal (#377) stated as an
# assertion rather than as a comment.
if ! cmp -s "$REPORT" "$POLL_REPORT"; then
  echo "FAIL: SCORE_API changed the judge's report"; exit 1
fi

echo "--- freeze: boot a second serve instance backed by real Redis (via SRH)"
docker run -d --name "$FREEZE_REDIS_CTR" --network "$NET" redis:7-alpine >/dev/null
docker run -d --name "$FREEZE_SRH_CTR" --network "$NET" \
  -e SRH_MODE=env -e SRH_TOKEN="$FREEZE_SRH_TOKEN" \
  -e SRH_CONNECTION_STRING="redis://$FREEZE_REDIS_CTR:6379" \
  hiett/serverless-redis-http:latest >/dev/null

srh_deadline=$((SECONDS + 30))
until docker exec "$FREEZE_SRH_CTR" wget -qO- \
  --header="Authorization: Bearer $FREEZE_SRH_TOKEN" --header='Content-Type: application/json' \
  --post-data='["PING"]' http://127.0.0.1:80/ 2>/dev/null | grep -q PONG; do
  [ "$SECONDS" -ge "$srh_deadline" ] && { echo "FAIL: srh never came up for freeze stage"; exit 1; }
  sleep 1
done

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

echo "ACCEPTANCE PASS"
