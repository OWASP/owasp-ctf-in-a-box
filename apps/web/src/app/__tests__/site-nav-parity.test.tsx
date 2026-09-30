// Header/footer nav parity, asserted through the REAL layouts.
//
// The header is rendered by the root layout and the footer by the `(site)`
// layout — two files, two call sites, and (since the header groups 2+ module
// links into a "Challenges" dropdown while the footer stays flat) two
// deliberately different SHAPES built from one shared resolved-modules read.
// They drifted once already, before the grouping existed: the header resolved
// its links from the module registry with the organizer's renames applied
// while the footer imported `site.ts`'s static `navLinks`, so a renamed
// module showed one label up top and a different one at the bottom of the
// very same page. Fixing the footer once doesn't stop that recurring;
// asserting both derive from the same resolved modules does.
//
// So this deliberately renders the actual layout components rather than
// feeding both a hand-built list (which would pass no matter what the layouts
// do). Everything stubbed below is orthogonal to nav links: fonts, the
// session-reading client controls, and the server-only settings read.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// One module renamed, one left at its registry default: the pair proves both
// halves of the contract at once — an override must reach BOTH surfaces, and
// a module with no override must read identically in both.
vi.mock("server-only", () => ({}));
// The redesigned landing reads the session (for the state-aware primary CTA),
// the viewer's team, and — once the event is past registration — the top of
// the leaderboard. These fixtures render signed-out with the board read
// failing, which the page must tolerate by hiding the strip.
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));
vi.mock("@/lib/team-store", () => ({ hasTeam: async () => false, getViewerTeam: async () => null }));
vi.mock("@/lib/leaderboard/source", () => ({
  getLeaderboardSource: async () => ({
    getLeaderboard: async () => {
      throw new Error("no leaderboard in this fixture");
    },
  }),
}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["secure-development", "quiz"]),
);
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` reads `moduleOverrides` from this; `enabledModuleIds`
  // mirrors the set the enabled-modules mock above serves.
  getAdminSettings: async () => ({
    moduleOverrides: { quiz: { title: "Round 1" } },
    enabledModuleIds: ["secure-development", "quiz"],
  }),
}));
// Two modules with nav entries, so there is something to disagree about.

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "" });
  return { Poppins: font, Barlow: font, Geist_Mono: font };
});
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/components/auth-nav", () => ({ default: () => null }));
vi.mock("@/components/visit-beacon", () => ({ default: () => null }));

import RootLayout from "@/app/layout";
import SiteLayout from "@/app/(site)/layout";
import { getNavGroups } from "@/lib/resolved-modules";
import { isNavGroup } from "@/lib/site";

/** Every `href` → the link texts rendered for it. A Map of sets because the
 *  header renders its nav twice (desktop + mobile menu). */
function linkLabels(html: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const [, href, label] of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)) {
    const labels = found.get(href) ?? new Set<string>();
    labels.add(label.trim());
    found.set(href, labels);
  }
  return found;
}

const headerHtml = renderToStaticMarkup(await RootLayout({ children: null }));
const footerHtml = renderToStaticMarkup(await SiteLayout({ children: null }));
const headerLinks = linkLabels(headerHtml);
const footerLinks = linkLabels(footerHtml);

// This mock config enables two modules with nav entries (secure-development,
// unrenamed; quiz, renamed to "Round 1"), so the header now collapses them
// into one "Challenges" dropdown (see buildNavGroups) instead of rendering
// two top-level links. That dropdown's items sit behind a `useState` toggle
// that starts closed, so — per this repo's testing rule that anything behind
// a client-side toggle never appears in `renderToStaticMarkup` — the header's
// initial render exposes neither module href as a plain `<a>`; only the
// footer (which stays flat, per design) does.
//
// The header/footer split this file used to pin was "the same static list,
// rendered two different ways." The two anti-drift assertions that actually
// carry that guarantee now are: the footer-label check below (an un-renamed
// module's `nav.label` survives, an override still wins — read straight off
// the rendered `(site)` layout) and the closed-trigger check after it (the
// header really did collapse into a dropdown, proven off the rendered root
// layout, not off a hand-called builder). Both render the REAL layout
// components, so a regression in either one's wiring — reverting the footer
// to `site.ts`'s static list, or the header silently falling back to flat
// links — fails a test here.
//
// A third assertion used to sit here comparing `getNavLinks()`/
// `getNavGroups()` against `buildNavLinks(resolved)`/`buildNavGroups(resolved)`
// called directly. That was a tautology, not a test: `getNavLinks` IS
// `buildNavLinks(await getResolvedModules())` verbatim (see
// resolved-modules.ts), so the assertion re-ran the exact same two lines of
// code on both sides of `toEqual` and could not fail without also changing
// what it was "checking" — it implied coverage of the shared-resolved-modules
// property that the render-based assertions below already provide for real.
// Removed rather than kept for looks. If you're tempted to re-add a
// direct-call comparison like it, don't: prove the property by rendering,
// the way the two assertions below do.
describe("header groups module nav links; footer stays flat", () => {
  const navGroups = getNavGroups();

  it("collapses 2+ module links into one dropdown labelled the literal \"Challenges\", using each module's title", async () => {
    const group = (await navGroups).find(isNavGroup);
    if (!group) throw new Error("expected getNavGroups() to contain a NavGroup");
    expect(group.label).toBe("Challenges");
    // secure-development has no override, so its child reads its registry
    // `displayName` ("Secure Development") — NOT its nav.label ("Challenges")
    // — while quiz's admin override ("Round 1") flows straight through.
    expect(group.items).toEqual([
      { href: "/challenges", label: "Secure Development" },
      { href: "/quiz", label: "Round 1" },
    ]);
  });

  it("keeps the footer flat: an un-renamed module's nav.label survives, an override still wins", async () => {
    expect(footerLinks.get("/challenges")).toEqual(new Set(["Challenges"]));
    expect(footerLinks.get("/quiz")).toEqual(new Set(["Round 1"]));
  });

  it("renders the header trigger closed by default, with the required ARIA wiring, and no module hrefs exposed until it opens", () => {
    expect(headerHtml).toMatch(/aria-haspopup="menu"/);
    expect(headerHtml).toMatch(/aria-expanded="false"/);
    expect(headerHtml).not.toContain('role="menu"');
    expect(headerLinks.has("/challenges"), "the collapsed dropdown must not leak its item hrefs into a closed render").toBe(false);
    expect(headerLinks.has("/quiz"), "the collapsed dropdown must not leak its item hrefs into a closed render").toBe(false);
  });
});

// The render test above proves the `(site)` layout's footer agrees with the
// header. But <SiteFooter> is rendered from THREE places — the `(site)`
// layout, the landing page, and the 404 — and the other two are far more
// expensive to render here (the landing page alone needs the challenge
// catalogue, next/image and the countdown stubbed). Rendering only one of
// three would leave the drift gated on the site we already fixed and open on
// the two we might add to next.
//
// So this asserts the invariant at the source level instead: every footer
// render site resolves its links. That is exactly the mistake that shipped —
// a footer built from `site.ts`'s static list rather than the resolved one —
// and it catches a fourth call site the day someone adds it.
// Strips full-line `//` comments and `import` statements before a file's
// source is scanned for `SiteFooter` usage below. Both are real text this
// file's own docs deliberately contain: the import line always reads
// `import SiteFooter from ...` (a bare mention, not a render site), and more
// than one render site documents the JSX-mount trap in a comment using the
// exact `<SiteFooter navLinks={...} />` spelling as its own illustration.
// Scanning unstripped text would count that import and that prose as render
// sites, which is not what "renders N footer(s)" below is supposed to mean.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line) && !/^\s*import\b/.test(line))
    .join("\n");
}

describe("every SiteFooter render site resolves its nav links", () => {
  const appDir = fileURLToPath(new URL("../", import.meta.url));

  const files = readdirSync(appDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx") && !f.includes("__tests__"))
    .map((f) => [f, readFileSync(join(appDir, f), "utf8")] as const)
    // `SiteFooter` is called and awaited as a plain function, not mounted as
    // `<SiteFooter .../>` JSX: since it became an async Server Component
    // (config v2, PR 1b), a nested `<SiteFooter>` element suspends under
    // `renderToStaticMarkup` (the same trap `(site)/layout.tsx` documents for
    // `PhaseLine`). The filter matches BOTH spellings — the call form
    // `SiteFooter(` this codebase actually uses, and a JSX mount
    // `<SiteFooter` a future regression might introduce — over `codeOnly`,
    // so a wrong JSX mount stays visible to this describe (and trips the
    // exact-file-list guard below) instead of silently falling out of the
    // file list.
    .filter(([, src]) => /(?:<|\b)SiteFooter[\s(]/.test(codeOnly(src)));

  it("finds every known render site", () => {
    // Guards the guard: if this drops to zero (a rename, a moved directory),
    // the assertions below would pass by iterating nothing.
    expect(files.map(([f]) => f).sort()).toEqual(
      ["(site)/layout.tsx", "not-found.tsx", "page.tsx"].sort(),
    );
  });

  // Deliberately two loose checks rather than one exact expression: call sites
  // legitimately differ (the landing page binds `const navLinks = await
  // getNavLinks()` once and reuses it; the others inline the await). Pinning
  // one spelling would fail on a harmless refactor while still missing a
  // footer fed from the static list, which is the failure that matters.
  it.each(files.map(([f]) => f))("%s passes resolved links", (file) => {
    const src = files.find(([f]) => f === file)![1];
    const code = codeOnly(src);
    const rendered = code.match(/(?:<|\b)SiteFooter[\s(]/g)?.length ?? 0;
    const passed = code.match(/SiteFooter\(\s*\{\s*navLinks\b/g)?.length ?? 0;
    expect(passed, `${file} renders ${rendered} footer(s), ${passed} given navLinks`).toBe(rendered);
    expect(src, `${file} must resolve its nav links`).toContain("getNavLinks");
    expect(src, `${file} must not read site.ts's unresolved navLinks`).not.toMatch(
      /import\s*\{[^}]*\bnavLinks\b[^}]*\}\s*from\s*["']@\/lib\/site["']/,
    );
  });
});
