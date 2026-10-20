#!/usr/bin/env bash
# Patched-scores-right gate — the POSITIVE direction of scoring verification.
#
# Sibling to acceptance-target.sh. That script proves a STOCK app scores 0/N
# (no free points). This one proves the opposite end: a *correctly patched*
# contestant fork scores EXACTLY the patched challenge — its points equal the
# catalogue difficulty, and every other challenge still fails. Nothing else in
# the kit proves the positive direction, so a scorer that silently stopped
# awarding points for a real fix would pass every existing gate.
#
# Usage: scripts/acceptance-patched.sh <target> <challenge-id>
#   e.g. scripts/acceptance-patched.sh juice-shop challenge-1-password-hash-leak
#
# It stages a pinned SOURCE tree, applies patches/<target>/<challenge-id>.patch —
# a reference fix that closes ONE challenge's vulnerability in SOURCE — builds the
# fork from its own Dockerfile, runs the judge, and asserts the positive result.
#
# WHICH SOURCE. vampi stages the ORIGINAL upstream (erev0s/VAmPI) — that gate was
# authored first, against original upstream, and is left as-is. The other five
# targets stage their OWASP-CTF *fork* pinned by commit SHA: the fork's CTF base
# branch is the exact tree a contestant forks and patches, and the authoritative
# per-challenge fixes (extracted from the private rubric repo's solutions/) apply
# to it directly. Both origins are just "a pinned source tree with a root
# Dockerfile"; the per-target config below is the only thing that differs.
#
# THE ANTI-VACUOUS-ZERO DISCIPLINE. A patch that breaks the build or the app's
# boot ALSO stops the exploit, which would score the challenge "patched" for the
# wrong reason while the whole app is down. This gate refuses that outcome:
#   * The judge only writes ctf-score.md when the exec runner measured EVERY
#     challenge; if the app stops answering the run aborts and NO report is
#     written (see scorer/src/judge.js "run.aborted"). So a report existing at
#     all proves all N challenges ran and reported.
#   * We then assert exactly ONE ✅ and (N-1) ❌. A ❌ means that challenge's
#     exploit child ran and the exploit SUCCEEDED — i.e. the app is up and still
#     genuinely vulnerable there. "1/N with the others unreached" cannot pass:
#     unreached challenges abort the run and produce no report.
#   * We assert the ✅ is the challenge we patched and its points equal the
#     catalogue difficulty (parsed independently from the catalogue JSON).
#   * POSITIVE CONTROL. The other-N-fail check proves the app is live for every
#     challenge EXCEPT the patched one — so on its own it cannot tell "vuln
#     closed" from "endpoint broke" for the ✅ row itself (a challenge whose
#     exploit test only asserts the exploit is absent scores ✅ just as well if
#     the route 500s or is deleted). So after the ✅ we boot the freshly built
#     patched image standalone and probe the endpoint the patch touched: it must
#     still return 200 with valid data. A broken endpoint FAILS the gate here.
#     (securityshepherd is control-exempt — a 3-container Maven TLS stack cannot
#     be re-booted standalone; see its arm for the honest residual gap.)
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/acceptance-lib.sh

TARGET="${1:?usage: $0 <target> <challenge-id>}"
CHALLENGE="${2:?usage: $0 <target> <challenge-id>}"

# --- Per-target source pin + positive-control strategy -------------------------
# UPSTREAM_REPO/REF pin a COMMIT (never a branch or bare tag: either can move and
# silently score a different app). CTRL_STRATEGY selects how the positive control
# re-boots the patched app: "standalone" (single container), "with-db" (app + a
# MariaDB sibling), or "exempt" (documented — the stack cannot be re-booted here).
# CTRL_PORT/CTRL_ENV feed acc_boot_standalone. Bump a pin only together with a
# fresh run of this gate and a re-verification of every patch for that target.
CTRL_ENV=()
CTRL_READY_PATH="/"   # readiness probe path for the standalone control (targets under
                      # a context path override this — "/" 404s for them).
PATCH_ADDS_DOCKERFILE=0    # 1 = the reference patch itself adds the root Dockerfile,
                           # so the staging precondition is skipped (asserted post-patch).
CTRL_REUSE_JUDGE_IMAGE=0   # 1 = the standalone control reuses the image the judge just
                           # built (ctf-app-under-test) instead of rebuilding $WS — for
                           # webgoat (runtime-only Dockerfile needs a Maven pass first)
                           # and vulnerableapp (skip a second multi-minute gradle build).
case "$TARGET" in
  vampi)
    UPSTREAM_REPO="${VAMPI_UPSTREAM_REPO:-erev0s/VAmPI}"
    UPSTREAM_REF="${VAMPI_UPSTREAM_REF:-f16052dce83f05847133ec98f01c5193a41de7d8}"
    CTRL_STRATEGY="standalone"; CTRL_PORT=5000; CTRL_ENV=(-e vulnerable=1)
    ;;
  juice-shop)
    UPSTREAM_REPO="${JS_UPSTREAM_REPO:-OWASP-CTF/juice-shop}"
    UPSTREAM_REF="${JS_UPSTREAM_REF:-bd2611f6cac491bb80c9fe54e954fd945c3ab5ba}"
    CTRL_STRATEGY="standalone"; CTRL_PORT=3000; CTRL_ENV=(-e NODE_ENV=unsafe)
    ;;
  dvwa)
    UPSTREAM_REPO="${DVWA_UPSTREAM_REPO:-OWASP-CTF/DVWA}"
    UPSTREAM_REF="${DVWA_UPSTREAM_REF:-ac660b488e317697712881716fa0c6da81fb23f4}"
    CTRL_STRATEGY="with-db"; CTRL_PORT=80
    ;;
  webgoat)
    UPSTREAM_REPO="${WEBGOAT_UPSTREAM_REPO:-OWASP-CTF/WebGoat}"
    UPSTREAM_REF="${WEBGOAT_UPSTREAM_REF:-d5db2ac648ea1e332460e83f6021f1742f6095c0}"
    CTRL_STRATEGY="standalone"; CTRL_PORT=8080; CTRL_READY_PATH="/WebGoat/login"
    # WebGoat binds localhost by default — unreachable via a published port. The
    # bring-up sets these; the standalone control must too or the boot never serves.
    CTRL_ENV=(-e WEBGOAT_HOST=0.0.0.0 -e WEBGOAT_PORT=8080)
    CTRL_REUSE_JUDGE_IMAGE=1
    ;;
  vulnerableapp)
    UPSTREAM_REPO="${VULNERABLEAPP_UPSTREAM_REPO:-OWASP-CTF/VulnerableApp}"
    UPSTREAM_REF="${VULNERABLEAPP_UPSTREAM_REF:-5a645ece33e363c1eda7a5ea79b56394d6c4def4}"
    CTRL_STRATEGY="standalone"; CTRL_PORT=9090; CTRL_READY_PATH="/VulnerableApp/"
    PATCH_ADDS_DOCKERFILE=1; CTRL_REUSE_JUDGE_IMAGE=1
    ;;
  securityshepherd)
    UPSTREAM_REPO="${SS_UPSTREAM_REPO:-OWASP-CTF/SecurityShepherd}"
    UPSTREAM_REF="${SS_UPSTREAM_REF:-cb4d85e214e8fe3adf9f1ee25418c932063e7fe9}"
    CTRL_STRATEGY="exempt"
    ;;
  *)
    echo "FAIL: unknown target '$TARGET'. Known: vampi juice-shop dvwa webgoat vulnerableapp securityshepherd."
    exit 1
    ;;
esac

PATCH="patches/$TARGET/$CHALLENGE.patch"
[ -f "$PATCH" ] || { echo "FAIL: no reference patch at $PATCH"; exit 1; }
PATCH_ABS="$PWD/$PATCH"

CATALOGUE="scorer/rubric.owasp/$TARGET/tests/challenges/catalogue.$TARGET.json"
[ -f "$CATALOGUE" ] || { echo "FAIL: no catalogue at $CATALOGUE"; exit 1; }

# Expected challenge count = number of catalogue entries (one "key" per challenge).
# Derived here rather than hardcoded, so the total is right for every target and a
# rubric that gained/lost a challenge fails loudly instead of silently.
# `grep -c` exits 1 on zero matches, which `set -e` would turn into a silent
# death one line before the message below — `|| true` keeps the guard reachable.
CAT_N="$(grep -c '"key":' "$CATALOGUE" || true)"
[ "${CAT_N:-0}" -gt 0 ] || { echo "FAIL: no challenges found in $CATALOGUE"; exit 1; }

# pins: the scorer image acc_build_scorer builds from this checkout
IMG="ctf-score:acceptance-$TARGET"
NET="ctf-acceptance-$TARGET"
TMP="$(mktemp -d)"
WS="$TMP/workspace"
mkdir -p "$WS"

CTRL_IMG="ctf-fork-$TARGET-control"
CTRL_NAME="ctf-ctrl-$TARGET"
CTRL_DB_NAME="ctf-ctrl-$TARGET-db"
cleanup() {
  docker rm -f "ctf-app-$TARGET" "$CTRL_NAME" "$CTRL_DB_NAME" >/dev/null 2>&1 || true
  docker rmi -f "$CTRL_IMG" >/dev/null 2>&1 || true
  docker network rm "$NET" "ctf-ctrl-dvwa-net" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

acc_build_scorer "$IMG"
docker network create --internal "$NET" >/dev/null 2>&1 || true
acc_url_for "$TARGET"

# Skip the pre-patch Dockerfile precondition when the patch itself adds it; the
# post-patch assertion below still catches a genuinely missing Dockerfile.
if [ "$PATCH_ADDS_DOCKERFILE" = 1 ]; then REQUIRE_DOCKERFILE=0; else REQUIRE_DOCKERFILE=1; fi
acc_stage_source "$WS" "$UPSTREAM_REPO" "$UPSTREAM_REF" "$REQUIRE_DOCKERFILE"

echo "Applying reference patch $PATCH …"
# git apply, because the staged tree is a git repo (acc_stage_source init/fetches
# it) and the patch is a git-format diff. --check first so a stale patch fails
# here with a clear message rather than as a confusing build error later.
git -C "$WS" apply --check "$PATCH_ABS" || {
  echo "FAIL: $PATCH does not apply cleanly to $UPSTREAM_REPO@${UPSTREAM_REF:0:12}."
  echo "The pin moved out from under the patch, or the patch is stale — regenerate it."
  exit 1
}
git -C "$WS" apply "$PATCH_ABS"

# Belt-and-braces: the Dockerfile must survive staging+patch, or the bring-up
# would fall through to the no-source error and the run would look like a
# packaging bug instead of a patch problem.
[ -f "$WS/Dockerfile" ] || { echo "FAIL: workspace lost its Dockerfile after patching"; exit 1; }

acc_write_event "$TMP/event.json"

echo "Scoring PATCHED $TARGET fork ($CHALLENGE) — expecting exactly that challenge solved…"
APP_IMAGE="" acc_run_judge

REPORT="$WS/ctf-score.md"
# The judge writes this ONLY when every challenge was measured (an aborted run —
# the app stopped answering — throws and writes nothing). So its very existence
# is the first anti-vacuous signal: all challenges ran and reported.
[ -f "$REPORT" ] || {
  echo
  echo "FAIL: no ctf-score.md produced. The exec runner aborts (and writes no report)"
  echo "when the app stops answering mid-run — a broken/booted-down patched app lands"
  echo "here, NOT at a vacuous 1/N. Check the judge output above."
  exit 1
}

echo
echo "----- ctf-score.md -----"
cat "$REPORT"
echo "------------------------"

SCORE="$(acc_score_counts "$REPORT")"
SOLVED_N="${SCORE% *}"
TOTAL_N="${SCORE#* }"

# The solved ids, authoritative, from the report's machine-readable marker:
#   <!-- ctf-score: {"author":...,"solved":["challenge-3-sqli"],...} -->
SOLVED_JSON="$(sed -n 's/.*"solved":\[\([^]]*\)\].*/\1/p' "$REPORT")"

# Count the result cells directly (fixed-string, emoji-safe on BSD and GNU).
N_PATCHED="$(grep -Fc '✅ Patched' "$REPORT" || true)"
N_NOTYET="$(grep -Fc '❌ Not yet' "$REPORT" || true)"

# Expected points = the catalogue difficulty for THIS challenge id (the lowercased
# catalogue key). Parsed with a real JSON reader, not line-oriented text: the six
# catalogues use different layouts — vampi is pretty-printed one-field-per-line,
# dvwa/others are compact one-object-per-line, and shepherd puts difficulty a few
# fields after the key. A regex/awk that assumed a layout silently mis-parsed (e.g.
# grabbing the "7" out of "Challenge-7-…" as the difficulty). Independent of the
# scorer's own loader, so comparing it to the report's points cross-checks the two.
EXPECTED_PTS="$(python3 -c '
import json, sys
cid, cat = sys.argv[1], sys.argv[2]
data = json.load(open(cat))
entries = data if isinstance(data, list) else data.get("challenges", data)
print(next((e.get("difficulty") for e in entries if str(e.get("key", "")).lower() == cid), ""))
' "$CHALLENGE" "$CATALOGUE")"
[ -n "$EXPECTED_PTS" ] || { echo "FAIL: challenge id '$CHALLENGE' not found in $CATALOGUE (or python3 unavailable)"; exit 1; }

# Points shown in the report for the one ✅ row.
PATCHED_ROW="$(grep -F '✅ Patched' "$REPORT" || true)"
PATCHED_PTS="$(printf '%s\n' "$PATCHED_ROW" | sed -n 's/^|[^|]*|[[:space:]]*\([0-9][0-9]*\)[[:space:]]*|.*/\1/p')"

EXPECT_NOTYET="$((CAT_N - 1))"

echo
echo "patched $TARGET/$CHALLENGE scored $SOLVED_N / $TOTAL_N"
echo "  solved ids: [$SOLVED_JSON]"
echo "  ✅ Patched cells: $N_PATCHED    ❌ Not yet cells: $N_NOTYET"
echo "  expected points (catalogue difficulty): $EXPECTED_PTS    reported points: ${PATCHED_PTS:-<none>}"

fail() { echo; echo "FAIL: $1"; exit 1; }

[ "$TOTAL_N" = "$CAT_N" ] || fail "expected $CAT_N challenges total (catalogue), saw $TOTAL_N — is the rubric wired up?"
# Exactly one solved, and it is the challenge we patched (not a different one).
[ "$SOLVED_N" = "1" ] || fail "expected exactly 1 challenge solved, saw $SOLVED_N."
[ "$N_PATCHED" = "1" ] || fail "expected exactly 1 ✅ Patched cell, saw $N_PATCHED."
[ "$SOLVED_JSON" = "\"$CHALLENGE\"" ] || fail "the solved challenge is [$SOLVED_JSON], not the patched \"$CHALLENGE\"."
# Anti-vacuous: the OTHER N-1 must be present AND genuinely failed (a ❌ cell means
# that exploit ran and succeeded). N-1 ❌ cells rules out "the others never ran".
[ "$N_NOTYET" = "$EXPECT_NOTYET" ] || fail "expected $EXPECT_NOTYET ❌ Not yet cells (the other challenges still exploitable), saw $N_NOTYET — the app may be broken/unreached rather than serving."
# Points equal the catalogue difficulty.
[ "$PATCHED_PTS" = "$EXPECTED_PTS" ] || fail "patched challenge scored $PATCHED_PTS points, expected catalogue difficulty $EXPECTED_PTS."

# --- Positive control ----------------------------------------------------------
# The checks above prove the app is live for every challenge EXCEPT the patched
# one. They CANNOT tell "vuln closed" from "endpoint broke" for the ✅ row: an
# exploit test that only asserts the exploit is absent scores ✅ just as well if
# the patched route now 500s or was deleted. So (where feasible) boot the freshly
# built patched image standalone and prove the endpoint the patch touched still
# SERVES valid data. A broken endpoint FAILS here — the exact vacuous win the gate
# exists for. The control is dispatched by CTRL_STRATEGY, then a per-challenge
# probe. Add a probe arm when you add a patch.
CTRL_BODY="$TMP/control-body.json"

run_probe() {
  # $1 = control base URL. Per-challenge endpoint probe against the live patched app.
  case "$CHALLENGE" in
    challenge-1-excessive-data-exposure)
      code="$(curl -s -o "$CTRL_BODY" -w '%{http_code}' "$1/users/v1/_debug")"
      [ "$code" = "200" ] || fail "positive control: GET /users/v1/_debug returned $code, not 200 — the patch broke/removed the endpoint instead of closing the leak."
      grep -q '"users"' "$CTRL_BODY" || fail "positive control: /_debug returned no users array — the patch gutted the endpoint rather than filtering it."
      grep -q 'name1' "$CTRL_BODY" || fail "positive control: /_debug served no seeded user — the endpoint returns no real data."
      if grep -q 'password' "$CTRL_BODY"; then fail "positive control: /_debug STILL contains a password field — the fix did not actually close the leak."; fi
      echo "  control OK: GET /users/v1/_debug → 200, serves users (username/email present), no password field."
      ;;
    challenge-3-sqli)
      code="$(curl -s -o "$CTRL_BODY" -w '%{http_code}' "$1/users/v1/name1")"
      [ "$code" = "200" ] || fail "positive control: GET /users/v1/name1 (a benign real lookup) returned $code, not 200 — the patch broke the endpoint."
      grep -q 'name1' "$CTRL_BODY" || fail "positive control: benign lookup for name1 served no user — the endpoint returns no real data."
      echo "  control OK: GET /users/v1/name1 → 200, a benign real lookup still resolves (the SQLi test also controls the injected-payload → 404 path)."
      ;;
    challenge-1-password-hash-leak)
      # Register + login (mirrors the rubric's helpers.registerAndLogin), then prove
      # /rest/user/whoami still SERVES an allow-listed field (email) — so the patch
      # narrowed the projection, it did not break the endpoint — while the password
      # hash it used to leak is gone.
      em="ctf-ctrl-$$@local.test"; pw="CtfCtl!23x"
      curl -s -o /dev/null -X POST "$1/api/Users" -H 'Content-Type: application/json' \
        -d "{\"email\":\"$em\",\"password\":\"$pw\",\"passwordRepeat\":\"$pw\",\"securityQuestion\":null,\"securityAnswer\":\"x\"}" || true
      login="$(curl -s -X POST "$1/rest/user/login" -H 'Content-Type: application/json' -d "{\"email\":\"$em\",\"password\":\"$pw\"}")"
      tok="$(printf '%s' "$login" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
      [ -n "$tok" ] || fail "positive control: could not log in the freshly registered control user — login returned: $login"
      code="$(curl -s -o "$CTRL_BODY" -w '%{http_code}' -H "Cookie: token=$tok" "$1/rest/user/whoami?fields=email")"
      [ "$code" = "200" ] || fail "positive control: GET /rest/user/whoami?fields=email returned $code, not 200 — the patch broke the endpoint."
      grep -q "$em" "$CTRL_BODY" || fail "positive control: whoami?fields=email served no email — the patch gutted the projection instead of allow-listing it."
      pwbody="$(curl -s -H "Cookie: token=$tok" "$1/rest/user/whoami?fields=password")"
      if grep -q '"password"' <<< "$pwbody"; then fail "positive control: whoami?fields=password STILL returns a password field — the fix did not close the leak."; fi
      echo "  control OK: whoami?fields=email → 200 serving the user's email; whoami?fields=password no longer returns the hash."
      ;;
    challenge-23-sql-injection-dml-update)
      # WebGoat has no default account: register + login webgoat/webgoat (mirrors the
      # bring-up + rubric helper), then POST the BENIGN valid attack8 input. The
      # parameterized query must still return Smith's row — a gutted endpoint fails here.
      # WebGoat serves under /WebGoat.
      wgjar="$TMP/wg-ctrl.jar"; wbase="$1/WebGoat"
      curl -s -c "$wgjar" -b "$wgjar" -o /dev/null "$wbase/login" || true
      curl -s -c "$wgjar" -b "$wgjar" -o /dev/null -X POST "$wbase/register.mvc" \
        --data-urlencode username=webgoat --data-urlencode password=webgoat \
        --data-urlencode matchingPassword=webgoat --data-urlencode agree=agree || true
      curl -s -c "$wgjar" -b "$wgjar" -o /dev/null -X POST "$wbase/login" \
        --data-urlencode username=webgoat --data-urlencode password=webgoat || true
      rc="$(curl -s -c "$wgjar" -b "$wgjar" -o /dev/null -w '%{http_code}' "$wbase/service/reportcard.mvc")"
      [ "$rc" = "200" ] || fail "positive control: webgoat session not authenticated (reportcard $rc) — cannot run the attack8 probe."
      code="$(curl -s -c "$wgjar" -b "$wgjar" -o "$CTRL_BODY" -w '%{http_code}' -X POST "$wbase/SqlInjection/attack8" \
        --data-urlencode name=Smith --data-urlencode auth_tan=3SL99A)"
      [ "$code" = "200" ] || fail "positive control: POST /SqlInjection/attack8 (benign valid input) returned $code, not 200 — the patch broke the endpoint."
      grep -qi 'smith' "$CTRL_BODY" || fail "positive control: attack8 with the correct name/TAN served no employee row (no 'Smith' in the response) — the patch gutted the query instead of parameterising it."
      echo "  control OK: attack8 with valid name=Smith/auth_tan=3SL99A → 200 serving Smith's row (parameterised query still resolves real data)."
      ;;
    challenge-33-error-sqli-level-1)
      # VulnerableApp serves under /VulnerableApp. A benign id=1 must still return a real
      # car record with NO SQL-error leak — proves the query was parameterised, not gutted
      # and not still leaking the DB error the rubric keys on.
      vbase="$1/VulnerableApp"
      code="$(curl -s -o "$CTRL_BODY" -w '%{http_code}' "$vbase/ErrorBasedSQLInjectionVulnerability/LEVEL_1?id=1")"
      [ "$code" = "200" ] || fail "positive control: GET /ErrorBasedSQLInjectionVulnerability/LEVEL_1?id=1 returned $code, not 200 — the patch broke the endpoint."
      [ -s "$CTRL_BODY" ] || fail "positive control: LEVEL_1?id=1 served an empty body — the patch gutted the endpoint rather than parameterising it."
      if grep -qiE 'JdbcSQL|bad SQL grammar|SQLException|org\.h2|moreInfo=' "$CTRL_BODY"; then fail "positive control: LEVEL_1?id=1 still leaks a SQL error for a benign id — the fix is incomplete."; fi
      echo "  control OK: LEVEL_1?id=1 → 200 serving a real record with no SQL-error leak."
      ;;
    *)
      fail "no positive control probe defined for $CHALLENGE — add a run_probe arm before shipping its patch."
      ;;
  esac
}

case "$CTRL_STRATEGY" in
  exempt)
    echo
    echo "Positive control: EXEMPT for $TARGET."
    echo "  $TARGET runs as a multi-container Maven stack (built by the bring-up, no"
    echo "  prebuilt image) that cannot be re-booted standalone here. The anti-vacuous"
    echo "  guarantee for the ✅ row therefore rests on the two in-judge signals only:"
    echo "  the report exists (⇒ all $CAT_N challenges were measured, no aborted run) and"
    echo "  the other $EXPECT_NOTYET rows genuinely failed (⇒ the app is live and still"
    echo "  vulnerable there). The one residual gap — 'patched row scored by breaking"
    echo "  its own endpoint' — is NOT closed by a standalone probe for this target."
    ;;
  standalone)
    echo
    echo "Positive control: booting the patched fork standalone to prove $CHALLENGE's endpoint still serves…"
    if [ "$CTRL_REUSE_JUDGE_IMAGE" = 1 ]; then
      # Reuse the exact image the judge just built. webgoat's root Dockerfile is
      # runtime-only (COPY target/*.jar) so a bare `docker build $WS` has no jar and
      # dies; vulnerableapp would otherwise re-run a multi-minute gradle build. Every
      # source-build bring-up tags its image ctf-app-under-test on the host daemon.
      # pins: built locally from the PR checkout, never pulled
      BOOT_IMG="ctf-app-under-test"
      docker image inspect "$BOOT_IMG" >/dev/null 2>&1 || fail "expected the judge's $BOOT_IMG image for the control, but it is gone."
    else
      BOOT_IMG="$CTRL_IMG"
      docker build -q -t "$BOOT_IMG" "$WS" >/dev/null   # cache-hot: the judge already built these layers
    fi
    # ${arr[@]+"${arr[@]}"} — expand to nothing when empty without tripping `set -u`
    # on bash 3.2 (macOS), where a bare "${arr[@]}" on an empty array is "unbound".
    CTRL_BASE="$(acc_boot_standalone "$BOOT_IMG" "$CTRL_NAME" "$CTRL_PORT" ${CTRL_ENV[@]+"${CTRL_ENV[@]}"})" || fail "could not boot the patched fork for the positive control."
    acc_wait_http "$CTRL_BASE" 180 "$CTRL_READY_PATH" || fail "the patched fork never became reachable for the positive control ($CTRL_BASE$CTRL_READY_PATH) — the patch may break the app's boot."
    if [ "$TARGET" = "vampi" ]; then
      # VAmPI boots with an empty DB; /createdb drop+create+reseeds it.
      curl -s -o /dev/null "$CTRL_BASE/createdb" || true
      sleep 2
    fi
    run_probe "$CTRL_BASE"
    docker rm -f "$CTRL_NAME" >/dev/null 2>&1 || true
    ;;
  with-db)
    echo
    echo "Positive control: booting the patched fork + a MariaDB sibling to prove $CHALLENGE's endpoint still serves…"
    docker build -q -t "$CTRL_IMG" "$WS" >/dev/null
    # Self-contained node control: init the DB (session + CSRF-gated setup.php), log
    # in as admin, set the security level, then probe the patched endpoint with a
    # BENIGN request and assert it still returns a real row. A patch that "scores" by
    # gutting the query to return nothing fails here. Runs inside the scorer image
    # (has node) on the same bridge net as the app+db — see acc_control_dvwa.
    cat > "$TMP/dvwa-ctrl.js" <<'JS'
const B = process.env.APP_URL;                 // http://dvwa
const CH = process.env.CHALLENGE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u, o = {}) => fetch(u, { signal: AbortSignal.timeout(8000), ...o });
const jar = new Map();
const addCookies = (res) => {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const h of list) { const p = h.split(';')[0].trim(); const i = p.indexOf('='); if (i < 0) continue; jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); }
};
const cookie = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');
const TOKENRE = /name=['"]user_token['"][^>]*value=['"]([^'"]+)['"]/;
(async () => {
  let up = false;
  for (let i = 0; i < 60; i++) { try { if ((await get(B + '/login.php')).status === 200) { up = true; break; } } catch {} await sleep(2000); }
  if (!up) { console.error('control: DVWA never served /login.php'); process.exit(2); }
  let ready = false;
  for (let i = 0; i < 30; i++) {
    jar.clear();
    let r = await get(B + '/setup.php'); addCookies(r); let t = (await r.text()).match(TOKENRE)?.[1] || '';
    await get(B + '/setup.php', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie() }, body: 'create_db=Create+%2F+Reset+Database&user_token=' + t }).then(addCookies).catch(() => {});
    let lg = await get(B + '/login.php'); addCookies(lg); let lt = (await lg.text()).match(TOKENRE)?.[1] || '';
    let lp = await get(B + '/login.php', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie() }, body: 'username=admin&password=password&Login=Login&user_token=' + lt }); addCookies(lp);
    if (lp.status === 302 && (lp.headers.get('location') || '').includes('index')) { ready = true; break; }
    await sleep(2000);
  }
  if (!ready) { console.error('control: DVWA DB never initialised / admin login failed'); process.exit(3); }
  { let r = await get(B + '/security.php', { headers: { cookie: cookie() } }); addCookies(r); let t = (await r.text()).match(TOKENRE)?.[1] || '';
    let p = await get(B + '/security.php', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie() }, body: 'security=low&seclev_submit=Submit&user_token=' + t }); addCookies(p);
    jar.set('security', 'low'); }
  if (CH === 'challenge-7-sql-injection-low') {
    const r = await get(B + "/vulnerabilities/sqli/?id=1&Submit=Submit", { headers: { cookie: cookie() } });
    const body = await r.text();
    if (r.status !== 200) { console.error('control: sqli page returned ' + r.status + ', not 200 — patch broke the endpoint'); process.exit(4); }
    if (!/First name/i.test(body)) { console.error('control: benign id=1 served no user row — the patch gutted the query instead of just parameterising it'); process.exit(5); }
    console.log('CONTROL_OK: sqli?id=1 -> 200 serving a real user row (endpoint parameterised, not gutted)');
    process.exit(0);
  }
  console.error('control: no probe defined for ' + CH + ' — add one before shipping its patch'); process.exit(6);
})();
JS
    acc_control_dvwa "$TMP/dvwa-ctrl.js" || fail "positive control failed for $TARGET/$CHALLENGE — the patched endpoint did not serve real data (see the control message above)."
    echo "  control OK: benign request still serves real user data (endpoint patched, not gutted)."
    ;;
  *)
    fail "unknown CTRL_STRATEGY '$CTRL_STRATEGY'."
    ;;
esac

echo
echo "PASS: patched $TARGET fork solves exactly $CHALLENGE for $EXPECTED_PTS point(s);"
echo "      the other $EXPECT_NOTYET challenges ran and still fail (app up and still vulnerable there);"
case "$CTRL_STRATEGY" in
  exempt) echo "      positive control is exempt for $TARGET (see the note above)." ;;
  *)      echo "      and the patched endpoint still serves valid data (positive control passed)." ;;
esac
