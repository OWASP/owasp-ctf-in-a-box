import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Exec-probe runner: score a challenge by running its node:test file in a child
// process and reading the reporter output. Ported from the upstream reference
// engine (dc34 .github/actions/ctf-score/src/score.ts). Every non-obvious
// behaviour below is load-bearing — see the comments before changing any of it.

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The child never colours a piped stdout today, but a reporter change should not
// silently break the markers below.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Whole-file completion marker. The spec reporter withholds the duration summary
// until the child is about to exit, so a child held open by a keep-alive socket
// never emits it — which is exactly why keyed runs prefer the per-test line.
const SUMMARY_MARKER = /\bduration_ms\b/;

// How many bare timeouts (with nothing having reported yet) to tolerate before
// declaring the target unreachable. Two distinguishes a systemic reachability
// failure from one genuinely slow challenge, capping waste at ~2 × safety.
const UNREACHABLE_ABORT_THRESHOLD = 2;

// How long to keep reading stdout after the child process itself is gone. See
// the "exit" handler in runChild: "exit" is not ordered against the stdout
// "data" events still queued behind it, so settling on it directly can drop the
// tail of a fast child's output — the very chunk carrying the reporter's
// verdict. Short enough not to matter next to the safety timeout, long enough
// for the pipe to be drained by the event loop.
const EXIT_DRAIN_MS = 300;

function safetyTimeoutMs(env) {
  const raw = Number(env.CTF_SCORE_SAFETY_MS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 30_000;
}

function resolveConcurrency(itemCount, requested, env) {
  const override = Number(env.CTF_SCORE_CONCURRENCY);
  const base = Number.isFinite(override) && override >= 1 ? Math.floor(override) : requested;
  const c = Number.isFinite(base) && base >= 1 ? Math.floor(base) : 1;
  return Math.max(1, Math.min(c, Math.max(1, itemCount)));
}

// Bounded worker pool preserving input order (results[i] <-> items[i]).
async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  const runner = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, runner));
  return results;
}

// Spawn one `node --test` child, resolving with its combined output. The child
// is killed as soon as isDone(output) is true rather than waited on, so a
// lingering keep-alive socket cannot stall the run; the safety SIGKILL bounds a
// child that never reports at all.
function runChild(args, env, isDone) {
  return new Promise((resolve) => {
    // Detached: the child becomes the leader of its own process group, so a
    // signal to -child.pid reaches it AND any worker process it spawns
    // internally — `node --test` spawns a further, isolated worker process
    // per test file by default. Signalling child.pid alone would kill only
    // the harness and leave that inner worker orphaned (reparented to init),
    // still running the hung test file for as long as it likes.
    const child = spawn(process.execPath, args, { env, detached: true });
    let buf = "";
    let settled = false;
    let done = false;
    let safetyFired = false;
    let hardKill;
    let drain;

    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // No POSIX process group available — fall back to the harness alone
        // rather than throwing.
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };

    const safety = setTimeout(() => {
      safetyFired = true;
      killGroup("SIGKILL");
    }, safetyTimeoutMs(env));

    const maybeKill = () => {
      if (done || !isDone(buf)) return;
      done = true;
      killGroup("SIGTERM");
      // Escalate if the graceful signal is ignored (open TLS sockets delay exit).
      hardKill = setTimeout(() => {
        killGroup("SIGKILL");
      }, 2_000);
    };

    child.stdout.on("data", (d) => { buf += d.toString(); maybeKill(); });
    child.stderr.on("data", (d) => { buf += d.toString(); });

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(safety);
      if (hardKill) clearTimeout(hardKill);
      if (drain) clearTimeout(drain);
      resolve({ output: buf, bareTimeout: safetyFired && !done });
    };
    // "close" is the primary settle: it fires only after stdio EOF, so `buf`
    // is guaranteed complete.
    child.on("close", finish);
    child.on("error", finish);
    // But "close" waits for stdio EOF, which a grandchild still holding the
    // pipes can keep open even after SIGKILL — so "exit" has to be wired too,
    // or such a run wedges until the whole job times out. "exit" fires when the
    // process is reaped, which is NOT ordered against stdout "data" events
    // already queued: a child that finishes fast and exits on its own can reach
    // it with the tail of its output still unread, and that tail is where the
    // reporter's verdict lives — settling there would grade a solved challenge
    // as unpatched. So "exit" only ARMS a short drain window; "close" still
    // wins whenever it arrives, and finish() clears the timer so it can neither
    // fire after a close-driven settle nor outlive it. Deliberately not
    // unref()'d: this timer may be the last thing keeping the loop alive, and
    // an unref'd one could let the process exit with the promise unsettled.
    child.on("exit", () => {
      if (settled || drain) return;
      drain = setTimeout(finish, EXIT_DRAIN_MS);
    });
  });
}

function scoreOne(challenge, abort, env) {
  const { file, key, byName, testsDir } = challenge.exec;
  const testPath = join(testsDir, file);
  if (!existsSync(testPath)) return Promise.resolve(false);
  // The target already proved unreachable — don't spawn, don't wait. But a
  // report from any challenge (even one that armed the abort a moment ago)
  // proves the target reachable after all, so the gate must stay disarmed
  // once that happens rather than latching permanently on `aborted` alone.
  // Counted, not just returned: a skipped challenge was never MEASURED, and
  // runExec reports that fact so the judge can refuse to publish a score built
  // partly out of challenges nobody ran.
  if (abort.aborted && !abort.anyReported) {
    abort.skipped += 1;
    return Promise.resolve(false);
  }

  // Deliberately NO --test-force-exit. WebGoat's rubric registers assignments
  // with top-level `await test(...)`; force-exit tears the child down before the
  // HTTP request runs, failing every test regardless of patch state.
  const baseArgs = ["--test", "--test-reporter=spec"];
  const keyed = byName && key ? key : null;
  const args = keyed
    ? [...baseArgs, `--test-name-pattern=^${escapeRegExp(keyed)}$`, testPath]
    : [...baseArgs, testPath];

  // Anchored to line start (with `m`) and closed with a lookahead rather than
  // `\b`, so the marker can only match the reporter's own summary line, never
  // a substring elsewhere in the buffer (defense-in-depth against a key
  // ending in a non-word character, which `\b` would fail to bound — no
  // real catalogue key does this today; RUBRIC_ID pins key charset).
  const passLine = keyed ? new RegExp(`^\\s*✔\\s+${escapeRegExp(keyed)}(?=\\s|$)`, "m") : null;
  const failLine = keyed ? new RegExp(`^\\s*✖\\s+${escapeRegExp(keyed)}(?=\\s|$)`, "m") : null;

  const isDone = (buf) => {
    const c = stripAnsi(buf);
    if (passLine && failLine && (passLine.test(c) || failLine.test(c))) return true;
    return SUMMARY_MARKER.test(c);
  };

  // Strip the runner's own context vars so the child does not mistake this for a
  // recursive test invocation when runExec is itself called from a test.
  const { NODE_TEST_CONTEXT: _ctx, NODE_TEST_WORKER_ID: _wid, ...childEnv } = env;

  // Recorded HERE, at the spawn decision, not by the child: a child that never
  // gets scheduled before its safety kill (CPU contention) can be reaped
  // without ever running a line, so a marker it writes itself cannot be trusted
  // to count spawns. The gate above has already run, so a skipped challenge is
  // never counted.
  abort.spawned += 1;
  return runChild(args, childEnv, isDone).then(({ output, bareTimeout }) => {
    if (bareTimeout) {
      // If anything has already reported, the app is proven reachable: this is
      // one slow challenge, not a dead target. Score it open and leave the
      // abort disarmed so slow challenges cannot zero out the rest.
      if (abort.anyReported) return false;
      abort.bareTimeouts += 1;
      if (abort.bareTimeouts >= UNREACHABLE_ABORT_THRESHOLD) abort.aborted = true;
      return false;
    }

    const clean = stripAnsi(output);
    let patched;
    let reported;
    if (keyed) {
      // The subtest must have actually run and passed. A zero-match pattern
      // produces neither line, so it stays unpatched.
      const passed = passLine.test(clean);
      const failed = failLine.test(clean);
      reported = passed || failed;
      patched = passed && !failed;
    } else {
      const num = (re) => {
        const m = clean.match(re);
        return m ? Number(m[1]) : NaN;
      };
      const passN = num(/^[^\n]*\bpass (\d+)\s*$/m);
      const failN = num(/^[^\n]*\bfail (\d+)\s*$/m);
      reported = SUMMARY_MARKER.test(clean);
      patched = Number.isFinite(failN) && failN === 0 && passN >= 1;
    }

    // Only a child that actually emitted a reporter marker proves the target
    // reachable. A child that died before reporting (e.g. a syntax error or
    // bad import in a rubric's test file) must not permanently disarm
    // unreachable detection for the rest of the run.
    if (reported) abort.anyReported = true;
    return patched;
  });
}

/**
 * Run every challenge's test in isolation.
 *
 * Returns `{ solved, aborted, spawned }`: the solved ids in input order, whether
 * the run gave up early because the target proved unreachable, and how many
 * probes were actually spawned. `aborted` is NOT a score — the short-circuited
 * challenges were never attempted, so a caller that reported `solved` alone
 * would be telling the contestant their patch earned nothing when in truth
 * nothing was measured. Callers must fail loudly on it.
 *
 * @param {Array} challenges  challenge objects carrying an `exec` descriptor
 * @param {object} opts
 * @param {number} opts.concurrency  target default; CTF_SCORE_CONCURRENCY overrides
 * @param {object} opts.env          process env forwarded to children
 */
export async function runExec(challenges, { concurrency = 1, env = process.env } = {}) {
  const abort = { bareTimeouts: 0, aborted: false, anyReported: false, skipped: 0, spawned: 0 };
  const outcomes = await runPool(
    challenges,
    (c) => scoreOne(c, abort, env),
    resolveConcurrency(challenges.length, concurrency, env),
  );
  return {
    solved: challenges.filter((_, i) => outcomes[i]).map((c) => c.id),
    // Keyed on challenges actually SKIPPED rather than on the abort flag: a
    // late report can disarm the gate (proving the target reachable after all)
    // and let the rest of the run proceed, but whatever was short-circuited in
    // the meantime still went unmeasured, and a score is only honest if every
    // challenge in it was tried.
    aborted: abort.skipped > 0,
    spawned: abort.spawned,
  };
}
