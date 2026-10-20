import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runExec } from "../src/exec.js";

const testsDir = join(import.meta.dirname, "fixtures", "exec-suite");
// runExec returns { solved, aborted }; most cases only care about the ids.
const solvedIds = async (...args) => (await runExec(...args)).solved;
const keyed = (key, id) => ({ id, name: key, points: 1, exec: { file: "Mixed.test.js", key, byName: true, testsDir } });
const whole = (file, id) => ({ id, name: file, points: 1, exec: { file, key: file, byName: false, testsDir } });

test("a keyed subtest that passes is solved", async () => {
  assert.deepEqual(await solvedIds([keyed("Sub-Pass", "sub-pass")], { concurrency: 1 }), ["sub-pass"]);
});

test("a run that completed is not reported as aborted", async () => {
  const { solved, aborted } = await runExec([keyed("Sub-Pass", "sub-pass")], { concurrency: 1 });
  assert.deepEqual(solved, ["sub-pass"]);
  assert.equal(aborted, false, "a completed run must not look like an unreachable target");
});

test("a keyed subtest that fails is not solved", async () => {
  assert.deepEqual(await solvedIds([keyed("Sub-Fail", "sub-fail")], { concurrency: 1 }), []);
});

test("a keyed subtest isolates its sibling — one file, independent results", async () => {
  const solved = await solvedIds(
    [keyed("Sub-Pass", "sub-pass"), keyed("Sub-Fail", "sub-fail")],
    { concurrency: 1 },
  );
  assert.deepEqual(solved, ["sub-pass"]);
});

test("a key matching no subtest is not solved", async () => {
  assert.deepEqual(await solvedIds([keyed("Sub-Absent", "sub-absent")], { concurrency: 1 }), []);
});

test("a whole-file run is solved only when every test in it passes", async () => {
  assert.deepEqual(await solvedIds([whole("Whole-File-Pass.test.js", "wf-pass")], { concurrency: 1 }), ["wf-pass"]);
  assert.deepEqual(await solvedIds([whole("Whole-File-Fail.test.js", "wf-fail")], { concurrency: 1 }), []);
});

test("a missing test file is not solved and does not throw", async () => {
  const missing = { id: "gone", name: "gone", points: 1, exec: { file: "Nope.test.js", key: "Nope", byName: false, testsDir } };
  assert.deepEqual(await solvedIds([missing], { concurrency: 1 }), []);
});

test("results keep catalogue order regardless of concurrency", async () => {
  const solved = await solvedIds(
    [keyed("Sub-Pass", "a-pass"), keyed("Sub-Fail", "b-fail"), keyed("Sub-Pass", "c-pass")],
    { concurrency: 3 },
  );
  assert.deepEqual(solved, ["a-pass", "c-pass"]);
});

test("concurrency 1 runs children strictly one at a time", async () => {
  // Serial execution is a hard requirement for several targets (dvwa, webgoat,
  // securityshepherd), whose tests mutate shared server state — a shared
  // attacker account, a per-user counter — so overlapping children corrupt each
  // other's results. `defaultConcurrency: 1` in targets.js only DOCUMENTS that;
  // this proves the runner honours it.
  //
  // Proof by overlap, not by clock: each child records the window it was inside
  // its test body (see Window.test.js). At concurrency 1 no two windows may
  // overlap; at concurrency 3 at least two must. Comparing total elapsed time
  // between the two runs would not be a proof at all — process-spawn jitter is
  // the same order as the difference being measured.
  const markerDir = mkdtempSync(join(tmpdir(), "ctf-score-window-"));
  const win = (id) => ({
    id, name: id, points: 1,
    exec: { file: "Window.test.js", key: "window", byName: false, testsDir },
  });
  // [start, end) per child, in the order the children wrote them.
  const windows = (marker) =>
    readFileSync(marker, "utf8").trim().split("\n")
      .map((l) => l.split(" ").slice(1).map(Number));
  const overlaps = (ws) => {
    let n = 0;
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        if (ws[i][0] < ws[j][1] && ws[j][0] < ws[i][1]) n++;
      }
    }
    return n;
  };

  try {
    const serialMarker = join(markerDir, "serial");
    await solvedIds([win("a"), win("b"), win("c")], {
      concurrency: 1,
      env: { ...process.env, EXEC_WINDOW_MARKER: serialMarker },
    });
    const serial = windows(serialMarker);
    assert.equal(serial.length, 3, "all three children must have recorded a window");
    assert.equal(overlaps(serial), 0, `concurrency 1 must not overlap any windows, got ${JSON.stringify(serial)}`);

    const parallelMarker = join(markerDir, "parallel");
    await solvedIds([win("a"), win("b"), win("c")], {
      concurrency: 3,
      env: { ...process.env, EXEC_WINDOW_MARKER: parallelMarker },
    });
    const parallel = windows(parallelMarker);
    assert.equal(parallel.length, 3, "all three children must have recorded a window");
    // The control: the fixture and the assertion above CAN see overlap, so the
    // serial result is the scheduler's doing and not an artifact of the probe.
    assert.ok(overlaps(parallel) >= 1, `concurrency 3 must overlap at least two windows, got ${JSON.stringify(parallel)}`);
  } finally {
    rmSync(markerDir, { recursive: true, force: true });
  }
});

test("stops spawning once the target proves unreachable", async () => {
  // Each child blocks forever on a real timer (see Hang.test.js — a bare
  // unsettled top-level await does NOT hold the event loop open), so none
  // ever reports. With a 300ms safety cap and concurrency 1, the first two
  // children each burn one full safety window before the second arms the
  // abort; the remaining three must be short-circuited before ever spawning.
  //
  // The direct proof of that is `spawned`, counted by the runner at the spawn
  // decision. It must NOT be a marker the child writes itself: under CPU load
  // a child can be reaped by its safety kill before `node --test` boots far
  // enough to run a line, so a child-written count undercounts and flakes
  // (issue #643). The elapsed-time assertion is kept only as a secondary
  // sanity net (a multiple of the injected safety window, not a bare literal)
  // against total wedging — `spawned` is what proves the early abort.
  const hang = (id) => ({
    id, name: id, points: 1,
    exec: { file: "Hang.test.js", key: "Hang", byName: false, testsDir },
  });
  const safetyMs = 300;
  const started = Date.now();
  const { solved, aborted, spawned } = await runExec([hang("a"), hang("b"), hang("c"), hang("d"), hang("e")], {
    concurrency: 1,
    env: { ...process.env, CTF_SCORE_SAFETY_MS: String(safetyMs) },
  });
  const elapsed = Date.now() - started;

  assert.deepEqual(solved, []);
  // The zero above is NOT a score, and runExec has to say so: three of the five
  // challenges were never attempted. judge.js turns this flag into a thrown
  // error rather than a confident 0/5 in the contestant's PR comment.
  assert.equal(aborted, true, "an unreachable target must report aborted");
  // Effect-based proof: exactly the two children that armed the abort ever
  // spawned; c, d, and e were short-circuited by the abort gate.
  assert.equal(spawned, 2, `expected exactly 2 children spawned before abort armed, got ${spawned}`);
  // Sanity net only — a generous multiple of the injected safety window, well
  // clear of the ~2× cost the effect assertion above already proves.
  assert.ok(elapsed < 20 * safetyMs, `expected early abort, took ${elapsed}ms (bound ${20 * safetyMs}ms)`);
});
