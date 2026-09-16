#!/usr/bin/env bash
# Load-test the box at N synthetic contestants (issue #439).
#
# Seeds N contestants INSIDE the Fly machine's app container (srh is on the
# private network; the container already holds the URL/token), then drives
# the two hot public reads with autocannon at fixed rates while sampling
# machine memory, and writes one Markdown report. --clean removes exactly what
# the seed recorded in its manifest (it needs no --count).
#
#   scripts/load-test.sh --app owasp-ctf --url https://ctf.dcotelo.dev [--count 200]
#                        [--report docs/superpowers/load-2026-09-16.md]
#   scripts/load-test.sh --app owasp-ctf --clean
#
# Pass bar (from the issue, restated on autocannon's percentiles — it reports
# p97.5, not p95, so the stricter one is used): /leaderboard p97.5 < 1.5 s at
# 10 rps, ?display=1 p97.5 < 1 s at 2 rps, zero 5xx, machine memory < 80 %.
# /api/admin/metrics needs an admin session this script deliberately does not
# carry (a cookie in an argument vector is readable by every local user) —
# time it from a logged-in tab. This script REPORTS; the human decides.
#
# Fail direction: the run itself must not lie. A seed that did not report
# success, or a memory sampler that produced no sample, exits non-zero after
# writing what it has — a report with no memory line cannot pass the bar.
set -euo pipefail

APP=""; URL=""; COUNT=200; REPORT=""; CLEAN=""; DURATION=60
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --count) COUNT="$2"; shift 2 ;;
    --report) REPORT="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --clean) CLEAN=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$APP" ]; then echo "FAIL: --app is required" >&2; exit 2; fi
if [ -z "$CLEAN" ] && [ -z "$URL" ]; then echo "FAIL: --url is required unless --clean" >&2; exit 2; fi
command -v fly >/dev/null || { echo "FAIL: fly CLI not found" >&2; exit 1; }
command -v node >/dev/null || { echo "FAIL: node not found" >&2; exit 1; }
if [ -z "$CLEAN" ]; then
  command -v npx >/dev/null || { echo "FAIL: npx not found (autocannon runs through it)" >&2; exit 1; }
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
MACHINE="$(fly machines list --app "$APP" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);process.stdout.write(m[0].id)})')"
if [ -z "$MACHINE" ]; then echo "FAIL: no machine found for $APP" >&2; exit 1; fi
echo "== app=$APP machine=$MACHINE"

# Ship the seeder and run it where srh is reachable.
echo "== uploading scripts/load-seed.mjs"
fly ssh sftp put "$HERE/load-seed.mjs" /tmp/load-seed.mjs --app "$APP" --machine "$MACHINE" --container app >/dev/null 2>&1 || \
  fly ssh sftp put "$HERE/load-seed.mjs" /tmp/load-seed.mjs --app "$APP" >/dev/null

if [ -n "$CLEAN" ]; then
  echo "== cleaning every synthetic contestant the box holds"
  CLEAN_OUT="$(fly ssh console --app "$APP" --machine "$MACHINE" --container app -C "node /tmp/load-seed.mjs --clean" 2>&1 | tail -1)"
  echo "   $CLEAN_OUT"
  if ! grep -q '"mode":"clean"' <<< "$CLEAN_OUT"; then echo "FAIL: clean did not report success" >&2; exit 1; fi
  exit 0
fi

echo "== seeding $COUNT synthetic contestants"
SEED_OUT="$(fly ssh console --app "$APP" --machine "$MACHINE" --container app -C "node /tmp/load-seed.mjs --count $COUNT" 2>&1 | tail -1)"
echo "   $SEED_OUT"
if ! grep -q '"mode":"seed"' <<< "$SEED_OUT"; then echo "FAIL: seed did not report success" >&2; exit 1; fi

if [ -z "$REPORT" ]; then
  mkdir -p "$HERE/../docs/superpowers"
  REPORT="$HERE/../docs/superpowers/load-$(date -u +%Y-%m-%d-%H%M).md"
fi
TMP="$(mktemp -d)"
MEM_PID=""
trap 'rm -rf "$TMP"; if [ -n "$MEM_PID" ]; then kill "$MEM_PID" 2>/dev/null || true; fi' EXIT

# Memory sampler: MemAvailable from inside the machine every 15 s. A sample
# that fails is COUNTED (mem.err), never silently dropped — the run fails at
# the end if no sample at all was taken.
sample_mem() {
  while true; do
    if out="$(fly ssh console --app "$APP" --machine "$MACHINE" --no-container -C "cat /proc/meminfo" 2>/dev/null \
      | awk -v t="$(date -u +%H:%M:%S)" '/MemTotal/{tot=$2} /MemAvailable/{av=$2} END{if(tot>0) printf "%s used=%.0f%% avail=%dMB\n", t, 100*(tot-av)/tot, av/1024}')" \
      && [ -n "$out" ]; then
      echo "$out" >> "$TMP/mem.log"
    else
      date -u +%H:%M:%S >> "$TMP/mem.err"
    fi
    sleep 15
  done
}
sample_mem & MEM_PID=$!

# One autocannon phase at a fixed rate; its JSON lands in $TMP/<name>.json.
run_phase() { # name path rate duration
  local name="$1" path="$2" rate="$3" dur="$4"
  echo "== phase $name: $path @ ${rate} rps for ${dur}s"
  npx --yes autocannon -d "$dur" -R "$rate" -c 10 --json "$URL$path" > "$TMP/$name.json" 2>/dev/null
}
# One Markdown table row from a phase's JSON. autocannon's latency summary
# carries p50 / p97.5 / p99 (no p95), which is why the bar is stated on p97.5.
summarize() { # name label
  # shellcheck disable=SC2016  # the ${} below is JS template syntax, not shell
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const p = r.latency, non2xx = r.non2xx || 0, e5 = (r.statusCodeStats && Object.entries(r.statusCodeStats).filter(([c]) => c >= "500").reduce((s, [, v]) => s + (v.count || v), 0)) || 0;
    console.log(`| ${process.argv[2]} | ${r.requests.average.toFixed(1)} | ${p.p50} ms | ${p.p97_5} ms | ${p.p99} ms | ${non2xx} | ${e5} |`);
  ' "$TMP/$1.json" "$2"
}

run_phase leaderboard "/leaderboard" 10 "$DURATION"
run_phase display "/leaderboard?display=1" 2 "$DURATION"
kill "$MEM_PID" 2>/dev/null || true
MEM_PID=""

MEM_SAMPLES=0
if [ -s "$TMP/mem.log" ]; then MEM_SAMPLES="$(wc -l < "$TMP/mem.log" | tr -d ' ')"; fi
MEM_FAILURES=0
if [ -s "$TMP/mem.err" ]; then MEM_FAILURES="$(wc -l < "$TMP/mem.err" | tr -d ' ')"; fi

{
  echo "# Load test — $APP — $(date -u +%Y-%m-%dT%H:%MZ)"
  echo
  echo "Seed: \`$SEED_OUT\`"
  echo
  echo "| phase | rps achieved | p50 | p97.5 | p99 | non-2xx | 5xx |"
  echo "|---|---|---|---|---|---|---|"
  summarize leaderboard "/leaderboard @10rps"
  summarize display "/leaderboard?display=1 @2rps"
  echo
  echo "Pass bar (p97.5 — autocannon's nearest percentile above the issue's p95): /leaderboard < 1500 ms; display < 1000 ms; zero 5xx; memory < 80 %. /api/admin/metrics is timed by hand from a logged-in tab."
  echo
  echo "## Machine memory (every 15 s; $MEM_SAMPLES samples, $MEM_FAILURES failed)"
  echo '```'
  if [ -s "$TMP/mem.log" ]; then cat "$TMP/mem.log"; else echo "(no samples — the run FAILS on this)"; fi
  echo '```'
  echo
  echo "Not seeded on purpose: ctf:classic:solvecount (a shared counter an exact clean could not lower back safely), hint purchases. Clean up with: scripts/load-test.sh --app $APP --clean"
} > "$REPORT"
echo "== report: $REPORT"
cat "$REPORT"
if [ "$MEM_SAMPLES" = 0 ]; then
  echo "FAIL: the memory sampler took no sample ($MEM_FAILURES attempts failed) — the memory criterion cannot be judged" >&2
  exit 1
fi
