// The pre-launch lock (#464) lives in each page and route rather than the
// proxy (which makes no Redis reads), so its failure mode is a NEW module
// page or route that forgets the guard. This test enumerates every module
// page and module API route on disk and fails if one does not call it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

function walk(dir: string, name: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return entry === "__tests__" ? [] : walk(p, name);
    return entry === name ? [p] : [];
  });
}

const rel = (p: string) => relative(SRC, p);

/** Contestant module pages: every page under these trees shows module
 *  content (challenge text, questions, standings) and must be locked. */
const MODULE_PAGE_ROOTS = ["challenges", "flags", "quiz", "ai", "leaderboard"].map((d) => join(SRC, "app/(site)", d));

/** Contestant module APIs. `hints/route.ts` is exempt on purpose: it returns
 *  only the viewer's OWN purchases and the hint price, never challenge text —
 *  the text comes from `hints/reveal`, which is locked. */
const MODULE_API_ROOTS = ["classic", "quiz", "hints", "board"].map((d) => join(SRC, "app/api", d));
const API_EXEMPT = new Set(["app/api/hints/route.ts"]);

describe("launch guard coverage (#464)", () => {
  const pages = MODULE_PAGE_ROOTS.flatMap((d) => walk(d, "page.tsx"));
  const routes = MODULE_API_ROOTS.flatMap((d) => walk(d, "route.ts")).filter((p) => !API_EXEMPT.has(rel(p)));

  it("finds the module pages and routes it is meant to check (anti-vacuous)", () => {
    expect(pages.length).toBeGreaterThanOrEqual(7);
    expect(routes.length).toBeGreaterThanOrEqual(4);
  });

  it.each(pages.map((p) => [rel(p), p]))("page %s calls redirectIfNotLaunched", (_name, p) => {
    expect(readFileSync(p, "utf8")).toContain("redirectIfNotLaunched(");
  });

  it.each(routes.map((p) => [rel(p), p]))("route %s calls requireLaunchedApi", (_name, p) => {
    expect(readFileSync(p, "utf8")).toContain("requireLaunchedApi(");
  });

  // The leaderboard page has no render test of its own (its dependency graph
  // is the whole fold), so pin the ORDER statically: the guard must run before
  // the board is read, or a refused viewer's request still computes standings.
  it("guards the leaderboard before it reads the board", () => {
    const src = readFileSync(join(SRC, "app/(site)/leaderboard/page.tsx"), "utf8");
    const guard = src.indexOf("await redirectIfNotLaunched(");
    const load = src.indexOf("getFoldedLeaderboard()");
    expect(guard).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(guard);
  });

  it("guards the ai launch-token mint (the server action behind /ai/[id])", () => {
    expect(readFileSync(join(SRC, "app/(site)/ai/[id]/actions.ts"), "utf8")).toMatch(/requireLaunchedApi\(|getLaunchAccess\(/);
  });
});
