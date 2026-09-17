#!/usr/bin/env bash
# Load-test the box at N synthetic contestants (issue #439).
#
# Seeds N contestants INSIDE the Fly machine's app container (srh is on the
# private network; the container already holds the URL/token), then drives
# the two hot public reads with autocannon at fixed rates while sampling
# machine memory, and writes one Markdown report. --clean removes exactly what
# the seed recorded in its manifest (it needs no --count).
#
#   scripts/load-test.sh --app <fly-app> --url https://<EVENT_URL> [--count 200]
#                        [--report docs/superpowers/load-2026-09-16.md]
#   scripts/load-test.sh --app <fly-app> --clean
#   scripts/load-test.sh --app <fly-app> --break-lock   # after a crashed run only
#
# Exit code: 0 only when the run was valid AND every criterion of the pass bar
# below was met; 1 when the run could not be trusted (setup, seed, a phase, or
# the sampler failed; connection errors or timeouts) OR the bar was missed
# (latency, a 5xx, memory). The report says which. 2 for a usage error.
#
# Pass bar (from the issue, restated on autocannon's percentiles — it reports
# p97.5, not p95, so the stricter one is used): /leaderboard p97.5 < 1.5 s at
# 10 rps, ?display=1 p97.5 < 1 s at 2 rps, zero 5xx, zero connection errors
# and zero timeouts (autocannon's `errors`/`timeouts`: a request that never
# got an answer is not a measurement, so any of them fails the RUN, not just
# the bar), machine memory < 80 %.
# /api/admin/metrics needs an admin session this script deliberately does not
# carry (a cookie in an argument vector is readable by every local user) —
# time it from a logged-in tab. The report carries every number; the exit
# code applies the bar so a run in CI or a shell loop cannot pass by accident.
#
# Fail direction: the run itself must not lie, and it writes ONE report no
# matter what. A setup step that fails (machine lookup, seeder upload) or a
# seed that did not report success drives nothing and writes a report saying
# so; a phase that fails to launch, or a memory sampler that
# produced no sample, is written into the report too; in every case the
# script exits non-zero AFTER the report — a report with a failed seed, a
# missing phase or no memory line cannot pass the bar, but it still says what
# happened.
set -euo pipefail

APP=""; URL=""; COUNT=200; REPORT=""; CLEAN=""; BREAK_LOCK=""; DURATION=60
LEADERBOARD_P975_MAX_MS=1500; DISPLAY_P975_MAX_MS=1000; MEM_USED_MAX_PCT=80
# A value-taking option with no value is a usage error (exit 2), not a
# `set -u` death with status 1.
need_value() { if [ "$#" -lt 2 ] || [ -z "$2" ]; then echo "FAIL: $1 needs a value" >&2; exit 2; fi; }
while [ $# -gt 0 ]; do
  case "$1" in
    --app) need_value "$@"; APP="$2"; shift 2 ;;
    --url) need_value "$@"; URL="$2"; shift 2 ;;
    --count) need_value "$@"; COUNT="$2"; shift 2 ;;
    --report) need_value "$@"; REPORT="$2"; shift 2 ;;
    --duration) need_value "$@"; DURATION="$2"; shift 2 ;;
    --clean) CLEAN=1; shift ;;
    --break-lock) BREAK_LOCK=1; CLEAN=1; shift ;;  # CLEAN=1: same no-report, no-URL path
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$APP" ]; then echo "FAIL: --app is required" >&2; exit 2; fi
if [ -z "$CLEAN" ] && [ -z "$URL" ]; then echo "FAIL: --url is required unless --clean" >&2; exit 2; fi
# COUNT and DURATION are interpolated into command lines (COUNT into the
# remote `-C` shell string), so they are validated as plain decimal numbers
# HERE, before anything reaches `fly ssh console` — the seeder's own range
# check runs too late to stop a value like `200; <anything>` from executing
# in the container.
# Length-capped in the case pattern too: a digit-only value past bash's
# integer range would make both `-lt`/`-gt` tests error out and fall through.
case "$COUNT" in ''|*[!0-9]*|?????*) echo "FAIL: --count must be a whole number (2..5000), got '$COUNT'" >&2; exit 2 ;; esac
if [ "$COUNT" -lt 2 ] || [ "$COUNT" -gt 5000 ]; then echo "FAIL: --count must be in 2..5000, got $COUNT" >&2; exit 2; fi
case "$DURATION" in ''|*[!0-9]*|?????*) echo "FAIL: --duration must be a whole number of seconds, got '$DURATION'" >&2; exit 2 ;; esac
if [ "$DURATION" -lt 5 ] || [ "$DURATION" -gt 3600 ]; then echo "FAIL: --duration must be in 5..3600 seconds, got $DURATION" >&2; exit 2; fi
command -v fly >/dev/null || { echo "FAIL: fly CLI not found" >&2; exit 1; }
command -v node >/dev/null || { echo "FAIL: node not found" >&2; exit 1; }
if [ -z "$CLEAN" ]; then
  command -v npx >/dev/null || { echo "FAIL: npx not found (autocannon runs through it)" >&2; exit 1; }
fi

HERE="$(cd "$(dirname "$0")" && pwd)"

# The report destination is prepared BEFORE anything is seeded: a run that
# cannot write its one report must not leave synthetic rows behind for the
# operator to discover. Default under docs/superpowers/ (gitignored).
if [ -z "$CLEAN" ]; then
  if [ -z "$REPORT" ]; then REPORT="$HERE/../docs/superpowers/load-$(date -u +%Y-%m-%d-%H%M).md"; fi
  REPORT_DIR="$(dirname "$REPORT")"
  if ! mkdir -p "$REPORT_DIR"; then echo "FAIL: cannot create the report directory $REPORT_DIR" >&2; exit 1; fi
  if ! : >> "$REPORT"; then echo "FAIL: cannot write the report at $REPORT" >&2; exit 1; fi
fi

# Setup (machine lookup, seeder upload) can fail before anything is seeded.
# On a load run that still owes the one report: write a setup-failure report
# naming the step, then exit 1. On --clean there is no report to owe.
fail_setup() { # step
  if [ -z "$CLEAN" ]; then
    {
      echo "# Load test — $APP — $(date -u +%Y-%m-%dT%H:%MZ)"
      echo
      echo "## Setup FAILED at: $1 — nothing was seeded or driven; the run FAILS"
      echo
      echo "Check \`fly status --app $APP\` and \`fly ssh console --app $APP\` by hand, then re-run."
    } > "$REPORT"
    echo "== report: $REPORT"
  fi
  echo "FAIL: $1" >&2
  exit 1
}

# The scratch directory is made here, BEFORE the seed, for the same reason as
# the report path: a run that cannot hold its own results must not seed.
TMP=""
MEM_PID=""
if [ -z "$CLEAN" ]; then
  if ! TMP="$(mktemp -d)"; then fail_setup "creating a temporary directory (mktemp -d)"; fi
  trap 'rm -rf "$TMP"; if [ -n "$MEM_PID" ]; then kill "$MEM_PID" 2>/dev/null || true; fi' EXIT
fi

MACHINE=""
if ! MACHINES_JSON="$(fly machines list --app "$APP" --json 2>/dev/null)"; then fail_setup "fly machines list failed for $APP"; fi
MACHINE="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const m=JSON.parse(s);process.stdout.write((m[0]&&m[0].id)||"")}catch{process.stdout.write("")}})' <<< "$MACHINES_JSON")"
if [ -z "$MACHINE" ]; then fail_setup "no machine found for $APP"; fi
echo "== app=$APP machine=$MACHINE"

# Ship the seeder to a per-run path inside the container (not a fixed name a
# stale copy could shadow) and run it where srh is reachable.
REMOTE_SEEDER="/tmp/load-seed-$(date -u +%Y%m%d%H%M%S)-$$.mjs"
echo "== uploading scripts/load-seed.mjs"
if ! fly ssh sftp put "$HERE/load-seed.mjs" "$REMOTE_SEEDER" --app "$APP" --machine "$MACHINE" --container app >/dev/null 2>&1; then
  # Same machine on the fallback (an older flyctl may not take --container);
  # the seed, clean and lock commands below all target $MACHINE.
  if ! fly ssh sftp put "$HERE/load-seed.mjs" "$REMOTE_SEEDER" --app "$APP" --machine "$MACHINE" >/dev/null 2>&1; then fail_setup "uploading the seeder to the app container"; fi
fi

if [ -n "$BREAK_LOCK" ]; then
  # Stale-lock recovery after a crashed run. The seeder is not in the app
  # image, so this is the one stable way to reach its --break-lock: the same
  # upload as a run, then the flag. Refuses if the lock changed hands.
  echo "== breaking a stale seed/clean lock (only do this when nothing is running)"
  BREAK_OUT="$(fly ssh console --app "$APP" --machine "$MACHINE" --container app -C "node $REMOTE_SEEDER --break-lock" 2>&1 | tail -1)"
  echo "   $BREAK_OUT"
  if ! grep -q '"mode":"break-lock"' <<< "$BREAK_OUT"; then echo "FAIL: break-lock did not report success" >&2; exit 1; fi
  exit 0
fi

if [ -n "$CLEAN" ]; then
  echo "== cleaning every synthetic contestant the box holds"
  CLEAN_OUT="$(fly ssh console --app "$APP" --machine "$MACHINE" --container app -C "node $REMOTE_SEEDER --clean" 2>&1 | tail -1)"
  echo "   $CLEAN_OUT"
  if ! grep -q '"mode":"clean"' <<< "$CLEAN_OUT"; then echo "FAIL: clean did not report success" >&2; exit 1; fi
  exit 0
fi

# The seed's status is captured, never allowed to end the script under
# `set -e`: a failed seed still gets its report (below), then exit 1. Its
# last output line is the seeder's own JSON summary or its redacted error
# label — nothing else the seeder prints reaches the report.
echo "== seeding $COUNT synthetic contestants"
SEED_STATUS=0
SEED_OUT="$(fly ssh console --app "$APP" --machine "$MACHINE" --container app -C "node $REMOTE_SEEDER --count $COUNT" 2>&1 | tail -1)" || SEED_STATUS=$?
echo "   $SEED_OUT"
if [ "$SEED_STATUS" -ne 0 ] || ! grep -q '"mode":"seed"' <<< "$SEED_OUT"; then
  {
    echo "# Load test — $APP — $(date -u +%Y-%m-%dT%H:%MZ)"
    echo
    echo "## Seed FAILED (exit $SEED_STATUS) — nothing was driven; the run FAILS"
    echo
    echo "Seeder said: \`$SEED_OUT\`"
    echo
    echo "If the seeder wrote any batch before failing, its manifest records them: run \`scripts/load-test.sh --app $APP --clean\` before seeding again."
  } > "$REPORT"
  echo "== report: $REPORT"
  echo "FAIL: seed did not report success (exit $SEED_STATUS)" >&2
  exit 1
fi

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
# A phase that fails to LAUNCH (autocannon missing, DNS, a nonzero exit) or
# leaves no result in autocannon's SHAPE (every field the table and the bar
# read must be a finite number — `{}` is not a measurement) is recorded in
# $TMP/phase.err and never aborts
# the script: the report still gets written, and the run fails at the end.
# Only the phase name and exit status are recorded — autocannon's own stderr
# can echo the target URL, so it is not persisted anywhere, not even in $TMP:
# its exit status is the whole diagnostic. Ordinary 5xx responses are not this
# path — autocannon records them in the JSON and summarize prints them.
PHASE_FAILURES=0
run_phase() { # name path rate duration
  local name="$1" path="$2" rate="$3" dur="$4" status=0 reason=""
  echo "== phase $name: $path @ ${rate} rps for ${dur}s"
  npx --yes autocannon -d "$dur" -R "$rate" -c 10 --json "${URL%/}$path" > "$TMP/$name.json" 2>/dev/null || status=$?
  if [ "$status" -ne 0 ]; then reason="autocannon exit $status"
  elif [ ! -s "$TMP/$name.json" ]; then reason="no result written"
  elif ! node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const num = (v) => typeof v === "number" && Number.isFinite(v);
      const ok = r && typeof r === "object"
        && r.requests && num(r.requests.average)
        && r.latency && num(r.latency.p50) && num(r.latency.p97_5) && num(r.latency.p99)
        && num(r.errors) && num(r.timeouts) && num(r.non2xx)
        && r.statusCodeStats && typeof r.statusCodeStats === "object";
      process.exit(ok ? 0 : 1);
    ' "$TMP/$name.json" >/dev/null 2>&1; then reason="result is not an autocannon summary (missing or non-numeric requests/latency/errors/timeouts/non2xx/statusCodeStats)"
  fi
  if [ -n "$reason" ]; then
    PHASE_FAILURES=$((PHASE_FAILURES + 1))
    echo "$name: $reason" >> "$TMP/phase.err"
    echo "   phase $name FAILED to run ($reason); continuing so the report is written" >&2
  fi
}
# One Markdown table row from a phase's JSON. autocannon's latency summary
# carries p50 / p97.5 / p99 (no p95), which is why the bar is stated on p97.5.
# A phase run_phase already marked failed prints a "did not run" row; the
# failure itself was counted there, so this never decides pass/fail.
summarize() { # name label
  if grep -q "^$1: " "$TMP/phase.err" 2>/dev/null; then echo "| $2 | did not run | — | — | — | — | — | — | — |"; return 0; fi
  # shellcheck disable=SC2016  # the ${} below is JS template syntax, not shell
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const p = r.latency || {}, non2xx = r.non2xx || 0, e5 = (r.statusCodeStats && Object.entries(r.statusCodeStats).filter(([c]) => c >= "500").reduce((s, [, v]) => s + (v.count || v), 0)) || 0;
    console.log(`| ${process.argv[2]} | ${(r.requests && r.requests.average || 0).toFixed(1)} | ${p.p50} ms | ${p.p97_5} ms | ${p.p99} ms | ${non2xx} | ${e5} | ${r.errors || 0} | ${r.timeouts || 0} |`);
  ' "$TMP/$1.json" "$2"
}

run_phase leaderboard "/leaderboard" 10 "$DURATION"
run_phase display "/leaderboard?display=1" 2 "$DURATION"
# Stop the sampler and WAIT for it, so a sample in flight lands in mem.log
# before the counts below read it.
kill "$MEM_PID" 2>/dev/null || true
wait "$MEM_PID" 2>/dev/null || true
MEM_PID=""

# Connection errors across the phases that ran (autocannon's `errors` already
# includes its `timeouts`, so only `errors` is summed — the table still shows
# both): a request that never got an answer is not a measurement, so any of
# them fails the run.
PROBE_ERRORS=0
for f in "$TMP"/leaderboard.json "$TMP"/display.json; do
  if [ -s "$f" ] && ! grep -q "^$(basename "$f" .json): " "$TMP/phase.err" 2>/dev/null; then
    n="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.errors||0))' "$f" 2>/dev/null || echo 0)"
    PROBE_ERRORS=$((PROBE_ERRORS + n))
  fi
done

MEM_SAMPLES=0
if [ -s "$TMP/mem.log" ]; then MEM_SAMPLES="$(wc -l < "$TMP/mem.log" | tr -d ' ')"; fi
MEM_FAILURES=0
if [ -s "$TMP/mem.err" ]; then MEM_FAILURES="$(wc -l < "$TMP/mem.err" | tr -d ' ')"; fi

{
  echo "# Load test — $APP — $(date -u +%Y-%m-%dT%H:%MZ)"
  echo
  echo "Seed: \`$SEED_OUT\`"
  echo
  echo "| phase | rps achieved | p50 | p97.5 | p99 | non-2xx | 5xx | conn errors | timeouts |"
  echo "|---|---|---|---|---|---|---|---|---|"
  summarize leaderboard "/leaderboard @10rps"
  summarize display "/leaderboard?display=1 @2rps"
  echo
  echo "Pass bar (p97.5 — autocannon's nearest percentile above the issue's p95): /leaderboard < 1500 ms; display < 1000 ms; zero 5xx; zero connection errors and timeouts (any fails the run: an unanswered request is not a measurement); memory < 80 %. /api/admin/metrics is timed by hand from a logged-in tab."
  echo
  if [ -s "$TMP/phase.err" ]; then
    echo "## Phases that did not run (the run FAILS on this)"
    echo '```'
    cat "$TMP/phase.err"
    echo '```'
    echo
  fi
  echo "## Machine memory (every 15 s; $MEM_SAMPLES samples, $MEM_FAILURES failed)"
  echo '```'
  if [ -s "$TMP/mem.log" ]; then cat "$TMP/mem.log"; else echo "(no samples — the run FAILS on this)"; fi
  echo '```'
  echo
  echo "Not seeded on purpose: ctf:classic:solvecount (a shared counter an exact clean could not lower back safely), hint purchases. Clean up with: scripts/load-test.sh --app $APP --clean"
} > "$REPORT"
echo "== report: $REPORT"
cat "$REPORT"
# The bar itself, applied at the exit boundary so a run cannot pass by
# accident: p97.5 per phase, any 5xx, any memory sample at or over the cap.
# Each miss is named on stderr; the report above already carries the numbers.
BAR_MISSES=0
bar_phase() { # name p975-max
  if [ ! -s "$TMP/$1.json" ] || grep -q "^$1: " "$TMP/phase.err" 2>/dev/null; then return 0; fi # counted as a phase failure already
  local out
  # shellcheck disable=SC2016  # the ${} below is JS template syntax, not shell
  out="$(node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const p975 = (r.latency && r.latency.p97_5) || 0;
    const e5 = (r.statusCodeStats && Object.entries(r.statusCodeStats).filter(([c]) => c >= "500").reduce((s, [, v]) => s + (v.count || v), 0)) || 0;
    const miss = [];
    if (p975 >= Number(process.argv[2])) miss.push(`p97.5 ${p975} ms >= ${process.argv[2]} ms`);
    if (e5 > 0) miss.push(`${e5} 5xx`);
    process.stdout.write(miss.join("; "));
  ' "$TMP/$1.json" "$2" 2>/dev/null || echo "result unreadable")"
  if [ -n "$out" ]; then echo "BAR MISSED: $1 — $out" >&2; BAR_MISSES=$((BAR_MISSES + 1)); fi
}
bar_phase leaderboard "$LEADERBOARD_P975_MAX_MS"
bar_phase display "$DISPLAY_P975_MAX_MS"
if [ -s "$TMP/mem.log" ]; then
  MEM_PEAK="$(sed -n 's/.*used=\([0-9]*\)%.*/\1/p' "$TMP/mem.log" | sort -n | tail -1)"
  if [ -n "$MEM_PEAK" ] && [ "$MEM_PEAK" -ge "$MEM_USED_MAX_PCT" ]; then echo "BAR MISSED: memory peaked at ${MEM_PEAK}% (cap ${MEM_USED_MAX_PCT}%)" >&2; BAR_MISSES=$((BAR_MISSES + 1)); fi
fi

RC=0
if [ "$BAR_MISSES" -ne 0 ]; then
  echo "FAIL: the pass bar was missed on $BAR_MISSES criterion/criteria (see BAR MISSED above and the report)" >&2
  RC=1
fi
if [ "$PROBE_ERRORS" -ne 0 ]; then
  echo "FAIL: $PROBE_ERRORS connection error(s) (timeouts included) across the phases — those requests were never answered, so the latency columns understate the truth" >&2
  RC=1
fi
if [ "$PHASE_FAILURES" -ne 0 ]; then
  echo "FAIL: $PHASE_FAILURES phase(s) did not run — see the report's 'Phases that did not run'" >&2
  RC=1
fi
if [ "$MEM_SAMPLES" = 0 ]; then
  echo "FAIL: the memory sampler took no sample ($MEM_FAILURES attempts failed) — the memory criterion cannot be judged" >&2
  RC=1
fi
exit "$RC"
