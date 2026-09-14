import { describe, expect, it, vi } from "vitest";

// buildNavGroups is pure and takes its modules as a plain argument.
// site.ts now also imports @/lib/enabled-modules (for getSite()), which
// carries `import "server-only"` — a no-op in Next's RSC bundling but a hard
// throw in plain vitest. Stub it out; none of these tests touch getSite().
vi.mock("@/lib/enabled-modules", () => ({ getAdminSettingsSnapshot: vi.fn(async () => null) }));

import { buildNavGroups, isNavGroup, type NavEntry } from "@/lib/site";

function group(entries: NavEntry[]) {
  const g = entries.find(isNavGroup);
  if (!g) throw new Error("expected a NavGroup in the result");
  return g;
}

describe("buildNavGroups", () => {
  it("collapses 2+ modules with a nav entry into one group parented \"Challenges\", with each module's title as the child label", () => {
    const entries = buildNavGroups([
      {
        id: "secure-development",
        nav: { href: "/challenges", label: "Challenges" },
        title: "Secure Development",
        titleOverride: undefined,
      } as never,
      {
        id: "quiz",
        nav: { href: "/quiz", label: "Quiz" },
        title: "Quiz",
        titleOverride: undefined,
      } as never,
      {
        id: "classic",
        nav: { href: "/flags", label: "Flags" },
        title: "Jeopardy",
        titleOverride: undefined,
      } as never,
    ]);

    const g = group(entries);
    expect(g.label).toBe("Challenges");
    expect(g.items).toEqual([
      { href: "/challenges", label: "Secure Development" },
      { href: "/quiz", label: "Quiz" },
      { href: "/flags", label: "Jeopardy" },
    ]);
  });

  // The regression this guards: reading `nav.label` for the child instead of
  // `title` would put "Challenges" inside a dropdown ALSO called "Challenges"
  // for secure-development, and would drop an organizer's rename for any
  // module whose override affects `title` but not the (non-overridable)
  // nav.label.
  it("flows an organizer's rename into the dropdown child label", () => {
    const entries = buildNavGroups([
      {
        id: "secure-development",
        nav: { href: "/challenges", label: "Challenges" },
        title: "Secure Development",
        titleOverride: undefined,
      } as never,
      {
        id: "quiz",
        nav: { href: "/quiz", label: "Quiz" },
        title: "Round 1",
        titleOverride: "Round 1",
      } as never,
    ]);
    expect(group(entries).items).toContainEqual({ href: "/quiz", label: "Round 1" });
  });

  // The regression this guards: exactly one module must NOT be wrapped in a
  // group, and must keep reading `titleOverride || nav.label` — the same rule
  // `buildNavLinks` follows — not `title`. Reading `title` here would rename
  // secure-development's nav from "Challenges" to "Secure Development" on
  // every single-module event that never touched the admin panel.
  it("renders exactly one module as a flat link labelled titleOverride || nav.label, not title, and not a group", () => {
    const entries = buildNavGroups([
      {
        id: "secure-development",
        nav: { href: "/challenges", label: "Challenges" },
        title: "Secure Development",
        titleOverride: undefined,
      } as never,
    ]);
    expect(entries.some(isNavGroup)).toBe(false);
    expect(entries).toContainEqual({ href: "/challenges", label: "Challenges" });
    expect(entries.some((e) => !isNavGroup(e) && e.label === "Secure Development")).toBe(false);
  });

  it("still applies the organizer's override on the single-module flat link", () => {
    const entries = buildNavGroups([
      {
        id: "quiz",
        nav: { href: "/quiz", label: "Quiz" },
        title: "Round 1",
        titleOverride: "Round 1",
      } as never,
    ]);
    expect(entries.some(isNavGroup)).toBe(false);
    expect(entries).toContainEqual({ href: "/quiz", label: "Round 1" });
  });

  it("contributes nothing for zero modules, keeping only the platform links", () => {
    const entries = buildNavGroups([]);
    expect(entries.some(isNavGroup)).toBe(false);
    expect(entries[0]).toEqual({ href: "/how-to-play", label: "How to Play" });
    expect(entries[entries.length - 1]).toEqual({ href: "/faq", label: "FAQ" });
  });

  it("keeps the platform's leading and trailing links in position around the group", () => {
    const entries = buildNavGroups([
      {
        id: "secure-development",
        nav: { href: "/challenges", label: "Challenges" },
        title: "Secure Development",
        titleOverride: undefined,
      } as never,
      {
        id: "quiz",
        nav: { href: "/quiz", label: "Quiz" },
        title: "Quiz",
        titleOverride: undefined,
      } as never,
    ]);
    expect(entries[0]).toEqual({ href: "/how-to-play", label: "How to Play" });
    expect(entries[entries.length - 1]).toEqual({ href: "/faq", label: "FAQ" });
    expect(entries.filter(isNavGroup)).toHaveLength(1);
  });
});
