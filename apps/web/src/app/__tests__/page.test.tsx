// Landing page with secure-development as the only enabled module — the
// shape every event has shipped so far, so a refactor that quietly drops a
// module's copy fails here first. Pinned explicitly (below) rather than left
// to a bake default: config v2 (issue #386) has no baked event.yaml any
// more, so "the shipped configuration" has to be named directly, the same
// way every other module-set fixture in this suite names its own.
//
// The other fixtures — quiz-only, two-module, and a module with no home block —
// each need their own module set, and `vi.mock` hoists per FILE, so they live
// in sibling files (page-quiz-only, page-two-modules, page-no-home), the same
// split lib/__tests__/modules-resolve.test.ts uses.
//
// @testing-library/react is not a dependency here and must not be added for
// this; renderToStaticMarkup (ships with react-dom) is enough, since these
// assertions are all on markup text.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// getResolvedModules is exercised for real (it is what pairs a module's home
// block with its organizer-resolved title), so its server-side deps are
// stubbed the same way lib/__tests__/resolved-modules.test.ts stubs them:
// `server-only` throws outside an RSC build, and the real `connection()`
// throws outside a Next request store.
vi.mock("server-only", () => ({}));
// The redesigned landing reads the session (for the state-aware primary CTA),
// the viewer's team, and — once the event is past registration — the top of
// the leaderboard. These fixtures render signed-out with the board read
// failing, which the page must tolerate by hiding the strip.
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));
vi.mock("@/lib/team-store", () => ({ hasTeam: async () => false, getViewerTeam: async () => null }));
// Switchable: the default fixture renders with the board read FAILING (the
// page must hide the strip), and the standings-strip test below swaps in a
// synthetic board for one render.
const board = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("@/lib/leaderboard/source", () => ({
  getLeaderboardSource: async () => ({
    getLeaderboard: async () => {
      if (board.data) return board.data;
      throw new Error("no leaderboard in this fixture");
    },
  }),
}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
// Mutable so the event-identity test below can swap in an organizer-named
// override for one render and put the default back — same pattern as
// `board` above.
const adminSettings = vi.hoisted(() => ({
  moduleOverrides: {} as Record<string, unknown>,
  enabledModuleIds: ["secure-development"] as string[],
  eventIdentity: undefined as { eventName?: string } | undefined,
  // Undefined by default: `getEnabledApps`/`getEnabledTotals` (real modules,
  // not mocked in this file) fall back to DEFAULT_SECURE_DEV_TARGETS (all
  // six) the same way a live "nothing stored" settings read does. The
  // catalogue-vs-enabled-count test below narrows this for one render.
  secureDevTargets: undefined as string[] | undefined,
}));
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` falls back to the baked shim's ALL-module
  // `defaultModuleIds` unless this names the shipped config's own set.
  getAdminSettings: async () => ({ ...adminSettings }),
}));
// Mutable so the catalogue-vs-enabled-count test below can swap in a
// successful catalogue response for one render — same pattern as `board`.
const catalogFixture = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("@/lib/challenges", () => ({ getChallengeCatalog: async () => catalogFixture.data }));
vi.mock("@/lib/modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules")>()),
  isModuleEnabled: (id: string) => id === "secure-development",
}));
// layout.tsx is imported for its `generateMetadata` export; its font loaders are
// build-time Next magic with no runtime implementation under Vitest.
vi.mock("next/font/google", () => {
  const font = () => ({ variable: "" });
  return { Poppins: font, Barlow: font, Geist_Mono: font };
});
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />
  ),
}));

import Home from "@/app/page";
import { generateMetadata } from "@/app/layout";
import { DEFAULT_EVENT_IDENTITY } from "@/lib/event-identity";
import { apps } from "@/lib/apps";
import OAuthErrorNotice from "@/components/oauth-error-notice";

const html = await Home().then(renderToStaticMarkup);
const metadata = await generateMetadata();

describe("landing page frame", () => {
  // This fixture's `@/lib/admin-store` mock stores no `eventIdentity`, so
  // `getSite()` falls back to the spec default (config v2, issue #386:
  // `getSite()` has no event.yaml bake to fall back to any more — the
  // default is the spec constant, full stop). Anchored to the <h1> rather
  // than a bare `toContain`, same reason as the "Renamed CTF" test below:
  // the evaluator-pitch card's own copy also says "OWASP CTF in a Box".
  it("renders the default event name in the headline when no identity is stored", () => {
    const headline = html.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1];
    expect(headline).toBe(DEFAULT_EVENT_IDENTITY.eventName);
  });

  // The redesigned frame: one primary action (state-aware — this fixture is
  // signed-out on a dateless event, so "Sign in and play"), the quiet
  // how-it-works link, and the evaluator card instead of the old five-CTA row
  // and tracking section (issue #200 / DESIGN.md).
  it("renders one primary action and the platform frame", () => {
    expect(html).toContain("Sign in and play");
    expect(html).toContain("How it works");
    expect(html).toContain("Run this for your own group");
    // The old equal-weight CTA row is gone.
    expect(html).not.toContain("Live leaderboard");
    expect(html).not.toContain("Track your progress live");
  });
});

describe("landing page with secure-development enabled", () => {
  it("renders the module's tagline under the event name", () => {
    expect(html).toContain("Secure Development");
  });

  it("renders the module's hero intro with the live target count", () => {
    expect(html).toContain(
      "Break real vulnerabilities in 6 deliberately vulnerable training apps, patch them for real, and ship the fix as a GitHub pull request.",
    );
  });

  it("renders the module's CTA into its own route", () => {
    expect(html).toContain('href="/challenges"');
    expect(html).toContain("Browse targets");
  });

  // The apostrophes are U+2019, exactly as the JSX's `&rsquo;` rendered them
  // before this copy moved into the registry — renderToStaticMarkup emits the
  // literal character, not an entity. Asserting on an ASCII "'" here would
  // quietly license a copy change.
  // The what-to-expect essay and the numbered steps left the landing page —
  // they are How to play's material, and the pitch page renders a game card
  // instead (DESIGN.md: "grading rules never live here").
  it("renders the game card, not the how-to steps", () => {
    expect(html).toContain("The game");
    expect(html).toContain("6 apps");
    expect(html).not.toContain("Pick a target");
    expect(html).not.toContain("Get scored automatically");
    expect(html).not.toContain("What to expect");
  });

  it("renders the module's bring-your-agent section", () => {
    expect(html).toContain("Bring your agent");
    expect(html).toContain("Please use AI");
    expect(html).toContain("the skill this event exists to build");
  });

  it("renders the Secure Agent Playbook card alongside it", () => {
    expect(html).toContain("Start with the OWASP Secure Agent Playbook");
    expect(html).toContain("https://github.com/OWASP/secure-agent-playbook");
  });

  it("renders the targets grid", () => {
    expect(html).toContain("6 real targets");
    expect(html).toContain("Juice Shop");
    expect(html).toContain("VAmPI");
  });

  // One module: the games section is headed "The game", singular.
  it("heads a single-module event's games section in the singular", () => {
    expect(html).toContain("The game<");
  });
});

describe("the hero standings strip", () => {
  // The default fixture's failing board read proves the strip HIDES (the
  // frame tests above render without it). This one proves what it says when
  // there is a board: the kicker names WHAT the rows are — three bare names
  // and numbers mean nothing to a first-time visitor — and points carry
  // their unit, like everywhere else in the app.
  it("labels the rows as teams and the numbers as points", async () => {
    board.data = {
      entries: [],
      teams: [
        { rank: 1, slug: "byte-me", name: "Byte Me", captain: "ada", points: 1458, members: ["ada"] },
        { rank: 2, slug: "zero-cool", name: "Zero Cool", captain: "kev", points: 750, members: ["kev"] },
      ],
      generatedAt: "2026-08-24T00:00:00.000Z",
      capabilities: { apps: false, teams: true, challenges: false },
    };
    try {
      const withBoard = await Home().then(renderToStaticMarkup);
      expect(withBoard).toContain("Top teams right now");
      expect(withBoard).toContain("Byte Me");
      expect(withBoard).toContain("1,458");
      expect(withBoard).toContain("pts");
      expect(withBoard).toContain("Full standings");
    } finally {
      board.data = null;
    }
  });

  it("hides itself when the board read fails", () => {
    expect(html).not.toContain("right now");
    expect(html).not.toContain("Full standings");
  });
});

describe("event identity reaches the landing page", () => {
  // Presence in Redis is not discoverability (config v2, issue #386): an
  // organizer's stored name must actually reach the rendered HTML, not just
  // round-trip through `getAdminSettings`.
  it("renders the organizer's configured name in the headline, not the default", async () => {
    adminSettings.eventIdentity = { eventName: "Renamed CTF" };
    try {
      const renamed = await Home().then(renderToStaticMarkup);
      // Anchored to the <h1> specifically, not a bare `toContain`: the
      // evaluator pitch card's own copy names the kit ("This event runs on
      // OWASP CTF in a Box: one machine, …") regardless of the organizer's identity,
      // so a page-wide check for "OWASP CTF in a Box" would fail even on a correctly
      // renamed event.
      const headline = renamed.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1];
      expect(headline).toBe("Renamed CTF");
    } finally {
      adminSettings.eventIdentity = undefined;
    }
  });
});

describe("GitHub OAuth callback error banner", () => {
  it("shows friendly copy and an alert region for application_suspended", async () => {
    const withError = await Home({
      searchParams: Promise.resolve({ error: "application_suspended" }),
    }).then(renderToStaticMarkup);
    expect(withError).toContain('role="alert"');
    expect(withError).toContain("sign-in app has been suspended");
    expect(withError).toContain("Try again");
  });

  it("shows friendly copy for access_denied", async () => {
    const withError = await Home({
      searchParams: Promise.resolve({ error: "access_denied" }),
    }).then(renderToStaticMarkup);
    expect(withError).toContain('role="alert"');
    expect(withError).toContain("cancelled");
  });

  it("shows friendly copy for redirect_uri_mismatch", async () => {
    const withError = await Home({
      searchParams: Promise.resolve({ error: "redirect_uri_mismatch" }),
    }).then(renderToStaticMarkup);
    expect(withError).toContain('role="alert"');
    expect(withError).toContain("organizer");
  });

  // Pre-merge finding ("Secrets & Challenge Data In Logs"): GitHub's
  // `error_description` is arbitrary provider-supplied text and must NEVER
  // reach the rendered page — not sanitized, not truncated, not at all —
  // whether the code is one this app recognizes or not.
  it("never renders a supplied error_description, known code or not", async () => {
    const sentinel = "TOTALLY-DISTINCTIVE-DESCRIPTION-TEXT-4f8c";
    const withKnownCode = await Home({
      searchParams: Promise.resolve({ error: "access_denied", error_description: sentinel }),
    }).then(renderToStaticMarkup);
    const withUnknownCode = await Home({
      searchParams: Promise.resolve({ error: "server_error", error_description: sentinel }),
    }).then(renderToStaticMarkup);
    expect(withKnownCode).not.toContain(sentinel);
    expect(withUnknownCode).not.toContain(sentinel);
  });

  it("renders the generic message plus the safely-shaped code for an unrecognized error code", async () => {
    const withError = await Home({
      searchParams: Promise.resolve({ error: "server_error" }),
    }).then(renderToStaticMarkup);
    expect(withError).toContain('role="alert"');
    expect(withError).toContain("GitHub sign-in did not complete.");
    expect(withError).toContain("server_error");
  });

  it("renders the generic message WITHOUT the code when the code isn't GitHub's shape (letters/digits/_/- only, <=40 chars)", async () => {
    const withError = await Home({
      searchParams: Promise.resolve({ error: "weird.code!" }),
    }).then(renderToStaticMarkup);
    expect(withError).toContain('role="alert"');
    expect(withError).toContain("GitHub sign-in did not complete.");
    expect(withError).not.toContain("weird.code!");
  });

  // Review finding: FRIENDLY_COPY is a plain object literal, and `error` is
  // an attacker-controlled query parameter. `FRIENDLY_COPY[error]` for
  // `error=constructor` (or `__proto__`, `toString`, `valueOf`,
  // `hasOwnProperty`) resolves to an inherited Object.prototype member, which
  // is truthy — so `??` never falls back, and `{message}` becomes a
  // function/object, which React refuses to render as a child (an
  // unauthenticated 500 on `/` from a crafted URL). `constructor` and
  // `__proto__` both happen to be shape-valid codes (letters and
  // underscores), so these also pin that the generic-plus-code path renders
  // them as plain text instead of throwing.
  it("falls back to the generic message (with the code) for a prototype-polluting error code, and does not throw", async () => {
    const withError = await Home({
      searchParams: Promise.resolve({ error: "constructor" }),
    }).then(renderToStaticMarkup);
    expect(withError).toContain('role="alert"');
    expect(withError).toContain("GitHub sign-in did not complete.");
    expect(withError).toContain("constructor");
  });

  it("falls back to the generic message (with the code) for __proto__, and does not throw", async () => {
    const withError = await Home({
      searchParams: Promise.resolve({ error: "__proto__" }),
    }).then(renderToStaticMarkup);
    expect(withError).toContain('role="alert"');
    expect(withError).toContain("GitHub sign-in did not complete.");
    expect(withError).toContain("__proto__");
  });

  it("renders no alert region when there are no error params", () => {
    expect(html).not.toContain('role="alert"');
  });
});

describe("GitHub OAuth callback: repeated query parameters", () => {
  // Next hands a repeated `?error=x&error=y` to searchParams as an array —
  // `FRIENDLY_COPY[error]` would then be indexed by an object, matching
  // nothing, unless the first value is normalized out first.
  it("uses the FIRST value when error is duplicated", async () => {
    const withError = await Home({
      searchParams: Promise.resolve({ error: ["access_denied", "redirect_uri_mismatch"] }),
    }).then(renderToStaticMarkup);
    expect(withError).toContain("cancelled"); // access_denied's own copy
    expect(withError).not.toContain("organizer"); // redirect_uri_mismatch's
  });
});

describe("GitHub OAuth callback: retry destination", () => {
  // Home() is an async Server Component: calling it returns the JSX element
  // tree, not rendered markup. A React element is a plain object with a
  // `type` and `props`, so the notice's computed `callbackURL` prop can be
  // read directly off the tree — no DOM, no testing-library, just the same
  // "probe the element" approach the rest of this repo's tests use, one
  // level earlier than a rendered string allows.
  function findElement(
    node: unknown,
    predicate: (el: { type: unknown; props: Record<string, unknown> }) => boolean,
  ): { type: unknown; props: Record<string, unknown> } | null {
    if (node == null || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findElement(child, predicate);
        if (found) return found;
      }
      return null;
    }
    const el = node as { type?: unknown; props?: { children?: unknown } };
    if ("type" in el && predicate(el as { type: unknown; props: Record<string, unknown> })) {
      return el as { type: unknown; props: Record<string, unknown> };
    }
    if (el.props && "children" in el.props) return findElement(el.props.children, predicate);
    return null;
  }

  async function retryDestination(
    searchParams: Record<string, string | string[] | undefined>,
  ): Promise<unknown> {
    const element = await Home({ searchParams: Promise.resolve(searchParams) });
    const notice = findElement(element, (n) => n.type === OAuthErrorNotice);
    return notice?.props.callbackURL;
  }

  it("carries a valid next through as the retry destination", async () => {
    expect(await retryDestination({ error: "access_denied", next: "/challenges" })).toBe("/challenges");
  });

  it("falls back to /profile for a protocol-relative next", async () => {
    expect(await retryDestination({ error: "access_denied", next: "//evil.example" })).toBe("/profile");
  });

  it("falls back to /profile for an absolute-URL next", async () => {
    expect(await retryDestination({ error: "access_denied", next: "https://evil.example" })).toBe(
      "/profile",
    );
  });

  it("falls back to /profile when next is missing", async () => {
    expect(await retryDestination({ error: "access_denied" })).toBe("/profile");
  });

  it("uses the FIRST value when next is duplicated", async () => {
    expect(
      await retryDestination({ error: "access_denied", next: ["/challenges", "/leaderboard"] }),
    ).toBe("/challenges");
  });
});

describe("root metadata", () => {
  it("describes the event with the enabled modules' taglines", () => {
    expect(metadata.description).toBe("OWASP CTF in a Box — Secure Development.");
  });

  it("no longer hardcodes secure-development copy onto every page", () => {
    expect(metadata.description).not.toContain("patch real vulnerabilities");
  });
});

describe("challenge counts follow the enabled targets, not the catalogue total", () => {
  // CodeRabbit round 1 / issue #391: the scorer's /challenges route returns
  // every rubric target, not the app's runtime secureDevTargets subset, so a
  // successful catalogue fetch's `total` (999, deliberately far from any
  // real app's challengeCount) can overcount once targets are narrowed. Both
  // aggregate values on this page — the hero copy via `ctx.totalChallenges`
  // and the targets section's own heading — must follow enabledTotals.challenges
  // instead.
  it("uses the enabled-target subset's count, not a larger catalogue total", async () => {
    adminSettings.secureDevTargets = ["dvwa"];
    catalogFixture.data = { byApp: {}, total: 999 };
    try {
      const narrowed = await Home().then(renderToStaticMarkup);
      const dvwa = apps.find((a) => a.id === "dvwa")!;
      expect(narrowed).toContain(`${dvwa.challengeCount} challenges up for grabs`);
      expect(narrowed).not.toContain("999 challenges");
    } finally {
      adminSettings.secureDevTargets = undefined;
      catalogFixture.data = null;
    }
  });
});
