#!/usr/bin/env bash
# Read-only score audit of a live box: recompute every contestant's and
# every team's score from the raw Redis rows and diff it against what
# /leaderboard serves (scripts/score-audit.mjs has the rules and the reasons).
#
#   scripts/score-audit.sh --app <fly-app> [--report <path>] [--settle-ms <ms>]
#
# Uploads scripts/score-audit.mjs into the Fly machine's app container (srh
# is on the private network; the container holds the URL/token and the
# scorer's address), runs it there against http://127.0.0.1:3000, pulls the
# JSON report back and prints the human summary. The auditor sends only
# read-only Redis commands (it refuses anything else before sending) and
# only GETs over HTTP; nothing on the box is written except the two scratch
# files under /tmp in the container, which are removed afterwards.
#
# Exit code: 0 only when the audit ran, compared a non-zero number of
# contestants/teams, and found zero board mismatches and zero store-invariant
# findings; 1 on any finding; 3 when the audit could not be trusted (vacuous,
# an unparseable payload, a store that kept changing, a failed read or
# setup step); 2 on a usage error.
set -euo pipefail

APP=""; REPORT=""; SETTLE_MS=12000
need_value() { if [ "$#" -lt 2 ] || [ -z "$2" ]; then echo "FAIL: $1 needs a value" >&2; exit 2; fi; }
while [ $# -gt 0 ]; do
  case "$1" in
    --app) need_value "$@"; APP="$2"; shift 2 ;;
    --report) need_value "$@"; REPORT="$2"; shift 2 ;;
    --settle-ms) need_value "$@"; SETTLE_MS="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$APP" ]; then echo "FAIL: --app is required" >&2; exit 2; fi
# APP and SETTLE_MS reach command lines (SETTLE_MS inside the remote `-C`
# shell string), so both are checked against a strict charset HERE, before
# anything reaches `fly ssh console`.
case "$APP" in *[!a-z0-9-]*|-*) echo "FAIL: --app must be a Fly app name (a-z, 0-9, -), got '$APP'" >&2; exit 2 ;; esac
case "$SETTLE_MS" in ''|*[!0-9]*|???????*) echo "FAIL: --settle-ms must be a whole number of milliseconds (0..120000), got '$SETTLE_MS'" >&2; exit 2 ;; esac
if [ "$SETTLE_MS" -gt 120000 ]; then echo "FAIL: --settle-ms must be at most 120000, got $SETTLE_MS" >&2; exit 2; fi
command -v fly >/dev/null || { echo "FAIL: fly CLI not found" >&2; exit 3; }
command -v node >/dev/null || { echo "FAIL: node not found" >&2; exit 3; }

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -z "$REPORT" ]; then REPORT="$HERE/../docs/superpowers/score-audit-$(date -u +%Y-%m-%d-%H%M%S).json"; fi
REPORT_DIR="$(dirname "$REPORT")"
if ! mkdir -p "$REPORT_DIR"; then echo "FAIL: cannot create the report directory $REPORT_DIR" >&2; exit 3; fi
if ! : >> "$REPORT"; then echo "FAIL: cannot write the report at $REPORT" >&2; exit 3; fi

if ! MACHINES_JSON="$(fly machines list --app "$APP" --json 2>/dev/null)"; then echo "FAIL: fly machines list failed for $APP" >&2; exit 3; fi
MACHINE="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const m=JSON.parse(s);process.stdout.write((m[0]&&m[0].id)||"")}catch{process.stdout.write("")}})' <<< "$MACHINES_JSON")"
case "$MACHINE" in ''|*[!a-z0-9]*) echo "FAIL: no usable machine id found for $APP" >&2; exit 3 ;; esac
echo "== app=$APP machine=$MACHINE"

# Per-run remote paths built from digits only, so nothing user-supplied is
# ever part of the remote command string.
STAMP="$(date -u +%Y%m%d%H%M%S)-$$"
REMOTE_JS="/tmp/score-audit-$STAMP.mjs"
REMOTE_REPORT="/tmp/score-audit-$STAMP.json"

remote() { # command string (built only from validated values above)
  fly ssh console --app "$APP" --machine "$MACHINE" --container app -C "$1"
}

echo "== uploading scripts/score-audit.mjs"
if ! fly ssh sftp put "$HERE/score-audit.mjs" "$REMOTE_JS" --app "$APP" --machine "$MACHINE" --container app >/dev/null 2>&1; then
  echo "FAIL: uploading the auditor to the app container" >&2; exit 3
fi
# Remove the two scratch files whatever happens next.
trap 'remote "rm -f $REMOTE_JS $REMOTE_REPORT" >/dev/null 2>&1 || true' EXIT

echo "== auditing (reads the store, fetches /leaderboard twice ${SETTLE_MS} ms apart, reads the store again)"
RUN_STATUS=0
RUN_OUT="$(remote "node $REMOTE_JS --report $REMOTE_REPORT --settle-ms $SETTLE_MS" 2>&1)" || RUN_STATUS=$?
printf '%s\n' "$RUN_OUT" | grep -v '^{"mode":"score-audit"' || true
LAST="$(printf '%s\n' "$RUN_OUT" | tr -d '\r' | grep '^{"mode":"score-audit"' | tail -1 || true)"
if [ -z "$LAST" ]; then echo "FAIL: the auditor printed no result line (exit $RUN_STATUS)" >&2; exit 3; fi

# The report is pulled whatever the verdict: a failed audit's report says why.
rm -f "$REPORT"
if ! fly ssh sftp get "$REMOTE_REPORT" "$REPORT" --app "$APP" --machine "$MACHINE" --container app >/dev/null 2>&1 || [ ! -s "$REPORT" ]; then
  echo "FAIL: could not pull the report from the container" >&2; exit 3
fi
echo "== report: $REPORT"

# The verdict comes from the report itself, not only the exit status a
# remote shell hands back: ok must be true AND something must have been
# compared, or the run does not pass.
VERDICT="$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const c = r.counts || {};
  const compared = (c.comparedContestants || 0) + (c.comparedTeams || 0);
  if (r.error || r.vacuous || compared === 0) process.stdout.write("3");
  else if (r.ok === true && (r.mismatches || []).length === 0 && (r.invariants || []).length === 0) process.stdout.write("0");
  else process.stdout.write("1");
' "$REPORT" 2>/dev/null || echo 3)"
if [ "$VERDICT" = 0 ] && [ "$RUN_STATUS" -ne 0 ]; then VERDICT=3; fi
case "$VERDICT" in
  0) echo "PASS: zero mismatches, zero invariant findings" ;;
  1) echo "FAIL: findings — see the MISMATCH/INVARIANT lines above and $REPORT" >&2 ;;
  *) echo "FAIL: the audit could not be trusted (vacuous, unparseable or unstable) — see $REPORT" >&2 ;;
esac
exit "$VERDICT"
