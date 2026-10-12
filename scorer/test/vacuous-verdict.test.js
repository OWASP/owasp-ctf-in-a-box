import test from "node:test";
import assert from "node:assert/strict";
import { summarize, verdict } from "../tools/vacuous-verdict.mjs";

// The sweep's pass/fail decision. Every case below is a run that LOOKS clean
// (zero vacuous ids) but measured nothing, and must fail; the first case is
// the honest clean run, which must pass, so the others are not failing for
// some unrelated reason.

// One result per personality, the shape sweepTarget returns.
const run = (targetName, { total = 3, vacuous = [], aborted = false, paths = ["/a", "/b", "/c"] } = {}) => ({
  targetName,
  personality: "empty-200",
  total,
  vacuous,
  aborted,
  requests: paths.length,
  paths,
});

test("a measured, clean run passes", () => {
  const v = verdict(summarize([run("vampi"), run("dvwa")]), ["vampi", "dvwa"]);
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
  assert.equal(v.total, 6);
});

test("a vacuous pass fails", () => {
  const v = verdict(summarize([run("vampi", { vacuous: ["x"] })]), ["vampi"]);
  assert.equal(v.ok, false);
  assert.equal(v.vacuous, 1);
});

test("an aborted run with zero vacuous ids fails: skipped challenges were never measured", () => {
  const v = verdict(summarize([run("vampi", { aborted: true })]), ["vampi"]);
  assert.equal(v.ok, false);
  assert.match(v.problems.join("\n"), /aborted/);
});

test("aborted under ONE personality fails the target", () => {
  const ok = run("vampi");
  const bad = { ...run("vampi", { aborted: true }), personality: "not-found" };
  const v = verdict(summarize([ok, bad]), ["vampi"]);
  assert.equal(v.ok, false);
});

test("a stuck run (every request on one path) with zero vacuous ids fails", () => {
  const v = verdict(summarize([run("vampi", { total: 9, paths: ["/login"] })]), ["vampi"]);
  assert.equal(v.ok, false);
  assert.match(v.problems.join("\n"), /shared gate/);
});

test("a single-challenge target on one path is not stuck", () => {
  const v = verdict(summarize([run("vampi", { total: 1, paths: ["/only"] })]), ["vampi"]);
  assert.equal(v.ok, true);
});

test("an expected target with no result fails", () => {
  const v = verdict(summarize([run("vampi")]), ["vampi", "webgoat"]);
  assert.equal(v.ok, false);
  assert.match(v.problems.join("\n"), /webgoat: not measured/);
});

test("an errored target is not measured, so it fails", () => {
  const v = verdict(summarize([{ targetName: "vampi", personality: "empty-200", error: "no urlEnv" }]), ["vampi"]);
  assert.equal(v.ok, false);
});

test("a target with zero challenges fails", () => {
  const v = verdict(summarize([run("vampi", { total: 0, paths: [] })]), ["vampi"]);
  assert.equal(v.ok, false);
});

test("an empty sweep fails", () => {
  const v = verdict(summarize([]), []);
  assert.equal(v.ok, false);
  assert.match(v.problems.join("\n"), /nothing was swept/);
});
