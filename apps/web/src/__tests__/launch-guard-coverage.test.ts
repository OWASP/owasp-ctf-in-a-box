// The pre-launch lock (#464) lives in each page and route rather than the
// proxy (which makes no Redis reads), so its failure mode is a NEW module
// page or route that forgets the guard. This test derives what to check from
// the module registry and the whole API tree — not a hand-kept list — and
// fails if anything that can serve module content does not call the guard.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_MODULE_ROUTES } from "@/lib/modules";

const SRC = join(__dirname, "..");
const APP = join(SRC, "app");

function walk(dir: string, name: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return entry === "__tests__" ? [] : walk(p, name);
    return entry === name ? [p] : [];
  });
}

const rel = (p: string) => relative(APP, p);

/** Every module board the registry knows about, plus the standings (module
 *  content that no single module owns). A new module's nav href lands here
 *  automatically. */
const PAGE_ROOTS = [...ALL_MODULE_ROUTES, "/leaderboard"].map((href) => join(APP, "(site)", href.replace(/^\//, "")));

/** API routes that are deliberately NOT behind the lock, each with why. Every
 *  other route under app/api must call the guard — a new one is checked the
 *  moment it exists. */
const API_EXEMPT: Record<string, string> = {
  "api/auth/[...all]/route.ts": "sign-in itself",
  "api/post-signin/route.ts": "the OAuth return leg",
  "api/me/admin/route.ts": "is the viewer an admin — no module content",
  "api/team/route.ts": "teams form before launch",
  "api/team/disband/route.ts": "teams form before launch",
  "api/team/join/route.ts": "teams form before launch",
  "api/team/leave/route.ts": "teams form before launch",
  "api/team/regen-code/route.ts": "teams form before launch",
  "api/team/remove/route.ts": "teams form before launch",
  "api/team/rename/route.ts": "teams form before launch",
  "api/team/solo/route.ts": "teams form before launch",
  "api/team/transfer/route.ts": "teams form before launch",
  "api/hints/route.ts": "the viewer's OWN purchases and the price — never hint text (hints/reveal is locked)",
  "api/public/scoring/route.ts": "scoring policy numbers a fork's Action needs",
  "api/stats/visit/route.ts": "a per-country counter",
  "api/sponsors/logo/[id]/route.ts": "sponsor logos, shown on the landing page",
  "api/ai/launch-key/route.ts": "a public key",
  "api/ai/submit/route.ts": "token-authenticated; the lock is enforced where the token is minted (/ai/[id])",
  "api/ai/event/route.ts": "token-authenticated; the lock is enforced where the token is minted (/ai/[id])",
  "api/ai/state/route.ts": "token-authenticated; the lock is enforced where the token is minted (/ai/[id])",
};

/** The source of a module's `generateMetadata` function, when it has one. */
function metadataSource(src: string): string | null {
  const start = src.indexOf("export async function generateMetadata");
  if (start === -1) return null;
  const end = src.indexOf("\nexport default", start);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("launch guard coverage (#464)", () => {
  const pages = PAGE_ROOTS.flatMap((d) => (existsSync(d) ? walk(d, "page.tsx") : []));
  const apiRoutes = walk(join(APP, "api"), "route.ts").filter((p) => !rel(p).startsWith("api/admin/"));
  const lockedRoutes = apiRoutes.filter((p) => !(rel(p) in API_EXEMPT));

  it("every registry route has a page tree, and the trees hold the pages it is meant to check (anti-vacuous)", () => {
    for (const d of PAGE_ROOTS) expect(existsSync(d), `missing page root ${d}`).toBe(true);
    expect(pages.length).toBeGreaterThanOrEqual(7);
    expect(lockedRoutes.length).toBeGreaterThanOrEqual(4);
  });

  it("names no exempt route that does not exist (a stale exemption hides nothing but misleads)", () => {
    const present = new Set(apiRoutes.map(rel));
    expect(Object.keys(API_EXEMPT).filter((r) => !present.has(r))).toEqual([]);
  });

  it.each(pages.map((p) => [rel(p), p]))("page %s awaits redirectIfNotLaunched", (_name, p) => {
    expect(readFileSync(p, "utf8")).toContain("await redirectIfNotLaunched(");
  });

  it.each(pages.map((p) => [rel(p), p]))("page %s shows an admin preview the banner", (_name, p) => {
    expect(readFileSync(p, "utf8")).toMatch(/\.preview && <PreviewBanner \/>/);
  });

  it.each(pages.map((p) => [rel(p), p]))("page %s locks its generateMetadata too (if it has one)", (_name, p) => {
    const meta = metadataSource(readFileSync(p, "utf8"));
    // Metadata that reads module CONTENT (a challenge/question list, a
    // viewer's progress, the standings) can leak it on its own path. Module
    // identity (title, blurb, target app names) is public on the landing page
    // anyway, so reading only that needs no guard.
    if (meta && /await (list[A-Z]\w*|getViewer\w*|getFolded\w*|getSolve\w*)\(/.test(meta)) {
      // classicVisibility (#186) is a lock too — it asks getLaunchAccess
      // itself (pinned by the next test), so the page and downloads share it.
      expect(meta).toMatch(/getLaunchAccess\(|await classicVisibility\(/);
    }
  });

  it("classicVisibility, the shared classic lock, asks the launch lock first", () => {
    const src = readFileSync(join(APP, "../lib/classic-visibility.ts"), "utf8");
    const launch = src.indexOf("await getLaunchAccess(");
    expect(launch).toBeGreaterThan(-1);
    expect(launch).toBeLessThan(src.indexOf("await listChallenges("));
  });

  it.each(lockedRoutes.map((p) => [rel(p), p]))("route %s calls the launch lock", (_name, p) => {
    expect(readFileSync(p, "utf8")).toMatch(/await (requireLaunchedApi|launchApiAccess)\(/);
  });

  it("guards the ai launch-token mint (the server action behind /ai/[id])", () => {
    expect(readFileSync(join(APP, "(site)/ai/[id]/actions.ts"), "utf8")).toContain("await getLaunchAccess(");
  });

  // The leaderboard page has no render test of its own (its dependency graph
  // is the whole fold), so pin the ORDER statically: the guard must run before
  // the board is read, or a refused viewer's request still computes standings.
  it("guards the leaderboard before it reads the board", () => {
    const src = readFileSync(join(APP, "(site)/leaderboard/page.tsx"), "utf8");
    const guard = src.indexOf("await redirectIfNotLaunched(");
    const load = src.indexOf("getFoldedLeaderboard()");
    expect(guard).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(guard);
  });
});
