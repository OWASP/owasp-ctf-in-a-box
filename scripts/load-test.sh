#!/usr/bin/env bash
# Load-test the box at N synthetic contestants (issue #439).
#
# Seeds N contestants INSIDE the Fly machine's app container (srh is on the
# private network; the container already holds the URL/token), then drives
# the three hot reads with autocannon at fixed rates while sampling machine
# memory, and writes one Markdown report. --clean removes the synthetic rows.
#
#   scripts/load-test.sh --app owasp-ctf --url https://ctf.dcotelo.dev [--count 200]
#                        [--admin-cookie 'better-auth.session_token=...']
#                        [--report docs/superpowers/load-2026-09-16.md]
#   scripts/load-test.sh --app owasp-ctf --count 200 --clean
#
# Pass bar (from the issue): /leaderboard p95 < 1.5 s at 10 rps, ?display=1
# p95 < 1 s at 2 rps, /api/admin/metrics < 5 s at 1 rps, zero 5xx, machine
# memory < 80 %. This script REPORTS; the human decides.
set -euo pipefail

APP=""; URL=""; COUNT=200; COOKIE=""; REPORT=""; CLEAN=""; DURATION=60
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --count) COUNT="$2"; shift 2 ;;
    --admin-cookie) COOKIE="$2"; shift 2 ;;
    --report) REPORT="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --clean) CLEAN=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$APP" ]; then echo "FAIL: --app is required" >&2; exit 2; fi
if [ -z "$CLEAN" ] && [ -z "$URL" ]; then echo "FAIL: --url is required unless --clean" >&2; exit 2; fi
command -v fly >/dev/null || { echo "FAIL: fly CLI not found" >&2; exit 1; }
command -v npx >/dev/null || { echo "FAIL: npx (node) not found" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
MACHINE="$(fly machines list --app "$APP" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);process.stdout.write(m[0].id)})')"
if [ -z "$MACHINE" ]; then echo "FAIL: no machine found for $APP" >&2; exit 1; fi
echo "== app=$APP machine=$MACHINE count=$COUNT"

# Ship the seeder and run it where srh is reachable.
echo "== uploading scripts/load-seed.mjs"
fly ssh sftp put "$HERE/load-seed.mjs" /tmp/load-seed.mjs --app "$APP" --machine "$MACHINE" --container app >/dev/null 2>&1 || \
  fly ssh sftp put "$HERE/load-seed.mjs" /tmp/load-seed.mjs --app "$APP" >/dev/null

if [ -n "$CLEAN" ]; then
  echo "== cleaning $COUNT synthetic contestants"
  fly ssh console --app "$APP" --machine "$MACHINE" --container app -C "node /tmp/load-seed.mjs --count $COUNT --clean"
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
trap 'rm -rf "$TMP"; kill "$MEM_PID" 2>/dev/null || true' EXIT

# Memory sampler: MemAvailable from inside the machine every 15 s.
sample_mem() {
  while true; do
    fly ssh console --app "$APP" --machine "$MACHINE" --no-container -C "cat /proc/meminfo" 2>/dev/null \
      | awk -v t="$(date -u +%H:%M:%S)" '/MemTotal/{tot=$2} /MemAvailable/{av=$2} END{if(tot>0) printf "%s used=%.0f%% avail=%dMB\n", t, 100*(tot-av)/tot, av/1024}' >> "$TMP/mem.log" || true
    sleep 15
  done
}
sample_mem & MEM_PID=$!

run_phase() { # name path rate duration [header]
  local name="$1" path="$2" rate="$3" dur="$4" hdr="${5:-}"
  echo "== phase $name: $path @ ${rate} rps for ${dur}s"
  if [ -n "$hdr" ]; then
    npx --yes autocannon -d "$dur" -R "$rate" -c 10 -H "$hdr" --json "$URL$path" > "$TMP/$name.json" 2>/dev/null
  else
    npx --yes autocannon -d "$dur" -R "$rate" -c 10 --json "$URL$path" > "$TMP/$name.json" 2>/dev/null
  fi
}
summarize() { # name -> markdown row
  # shellcheck disable=SC2016  # the ${} below is JS template syntax, not shell
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const p = r.latency, non2xx = r.non2xx || 0, e5 = (r.statusCodeStats && Object.entries(r.statusCodeStats).filter(([c]) => c >= "500").reduce((s, [, v]) => s + (v.count || v), 0)) || 0;
    console.log(`| ${process.argv[2]} | ${r.requests.average.toFixed(1)} | ${p.p50} ms | ${p.p97_5 || p.p99} ms | ${p.p99} ms | ${non2xx} | ${e5} |`);
  ' "$TMP/$1.json" "$2"
}

run_phase leaderboard "/leaderboard" 10 "$DURATION"
run_phase display "/leaderboard?display=1" 2 "$DURATION"
if [ -n "$COOKIE" ]; then run_phase metrics "/api/admin/metrics" 1 30 "Cookie: $COOKIE"; fi
kill "$MEM_PID" 2>/dev/null || true

{
  echo "# Load test — $APP — $(date -u +%Y-%m-%dT%H:%MZ)"
  echo
  echo "Seed: \`$SEED_OUT\`"
  echo
  echo "| phase | rps achieved | p50 | p97.5 | p99 | non-2xx | 5xx |"
  echo "|---|---|---|---|---|---|---|"
  summarize leaderboard "/leaderboard @10rps"
  summarize display "/leaderboard?display=1 @2rps"
  if [ -n "$COOKIE" ]; then summarize metrics "/api/admin/metrics @1rps"; fi
  echo
  echo "Pass bar: /leaderboard p95 < 1500 ms; display < 1000 ms; metrics < 5000 ms; zero 5xx; memory < 80 %."
  echo
  echo "## Machine memory (every 15 s)"
  echo '```'
  cat "$TMP/mem.log" 2>/dev/null || echo "(no samples)"
  echo '```'
  echo
  echo "Not seeded on purpose: ctf:classic:solvecount, hint purchases. Clean up with: scripts/load-test.sh --app $APP --count $COUNT --clean"
} > "$REPORT"
echo "== report: $REPORT"
cat "$REPORT"
