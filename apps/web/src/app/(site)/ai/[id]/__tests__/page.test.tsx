// The ai module's dedicated challenge page — mirrors
// flags/[id]/__tests__/page.test.tsx's static-render pattern and mock set,
// plus this module's own thing: the launcher, and the mint behind it. The
// pins that matter here: the 404 gates (module off, unknown id), the view
// model deriving the same states the board derives, the mint happening ONLY
// for a signed-in AND teamed viewer, the minted token appearing in the
// rendered payload EXACTLY ONCE (and nowhere else — not in a prop handed to
// a child component, not logged to the console), and event-mode hiding the
// flag form while flag/both show it.
//
// <ChallengeDetail> is mocked with a SPY component rather than rendered for
// real. Two reasons: `renderToStaticMarkup` only serializes the HTML a
// component returns — a prop it receives but never renders (an extra
// `launchUrl` prop, say) is invisible to any assertion on the html string, so
// a spy is the only way to pin "the token never reaches this component's
// props" at all. It also keeps this suite from re-testing ChallengeDetail's
// own internal rendering rules (solved hides the form, the cooldown copy,
// etc.) — those are already pinned in
// src/components/__tests__/challenge-detail.test.tsx; this file's job is only
// to check the PAGE passes the right props to it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const {
  isModuleEnabled,
  isAdminLogin,
  getSession,
  listAiChallenges,
  getAiSolveCounts,
  getViewerAi,
  getResolvedModules,
  mintLaunchUrl,
  redirectIfTeamless,
  requireGatePassed,
  challengeDetailSpy,
  headersRef,
  getAiHintIds,
  getHintNotice,
  getViewerHints,
} = vi.hoisted(() => ({
  isModuleEnabled: vi.fn(),
  isAdminLogin: vi.fn(),
  getSession: vi.fn(),
  listAiChallenges: vi.fn(),
  getAiSolveCounts: vi.fn(),
  getViewerAi: vi.fn(),
  getResolvedModules: vi.fn(),
  mintLaunchUrl: vi.fn(),
  redirectIfTeamless: vi.fn(),
  requireGatePassed: vi.fn(),
  challengeDetailSpy: vi.fn(),
  // Mutable so a test can put caller-controlled headers on the request and
  // pin that the mint ignores them. A `vi.mock` factory is hoisted above every
  // top-level binding, so the box has to come from `vi.hoisted` too.
  headersRef: { current: new Headers() },
  getAiHintIds: vi.fn(),
  getHintNotice: vi.fn(),
  getViewerHints: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
vi.mock("next/headers", () => ({ headers: () => headersRef.current }));
// The hint block renders a real HintRevealButton (unlike ChallengeDetail, which is
// spied below) — it calls useRouter for its post-reveal refresh, same reason
// flags/[id]'s suite mocks this. Every other export (redirect, notFound)
// stays real, since the gate tests below exercise the real `redirect()`.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/modules", () => ({ isModuleEnabled }));
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/admin-auth", () => ({ isAdminLogin }));
vi.mock("@/lib/ai-launch", () => ({ mintLaunchUrl }));
vi.mock("@/lib/require-team", () => ({ redirectIfTeamless }));
vi.mock("@/lib/gate-request", () => ({ requireGatePassed }));
vi.mock("@/lib/hint-store", () => ({ getAiHintIds, getHintNotice, getViewerHints }));
vi.mock("@/lib/ai-store", () => ({
  listAiChallenges,
  getAiSolveCounts,
  getViewerAi,
  AI_COOLDOWN_SEC: 5,
}));
// The spy: records every call's props (so a test can assert on exactly what
// the page handed it — including a field the page should never pass at all)
// and renders nothing, since this suite never needs to read its markup.
vi.mock("@/components/challenge-detail", () => ({
  __esModule: true,
  default: (props: unknown) => {
    challengeDetailSpy(props);
    return null;
  },
}));

import AiChallengePage, { generateMetadata } from "@/app/(site)/ai/[id]/page";

// The store record's public shape carries `urlTemplate` and `mode`, which the
// page reads directly off `challenge` — never through the view model handed
// to <ChallengeDetail>. `urlTemplate` still has the raw `{token}` placeholder
// in it here, exactly as an authored record would, so a test below can pin
// that the placeholder itself never reaches the markup.
const flagChallenge = {
  id: "a1",
  title: "Prompt Leak",
  category: "Prompt Injection",
  description: "Get the model to **leak** its system prompt.",
  points: 40,
  order: 0,
  mode: "flag" as const,
  urlTemplate: "https://example-challenge.test/launch?token={token}",
  caseSensitive: true,
};

const eventChallenge = {
  id: "a2",
  title: "Jailbreak the Guard",
  category: "Guardrails",
  description: "The external side reports the solve back.",
  points: 60,
  order: 1,
  mode: "event" as const,
  urlTemplate: "https://example-challenge.test/launch?token={token}",
};

const MINTED_URL = "https://example-challenge.test/launch?token=TESTTOKENVALUE123";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  headersRef.current = new Headers();
  isModuleEnabled.mockReturnValue(true);
  isAdminLogin.mockReturnValue(false);
  getSession.mockResolvedValue({ user: { login: "alice" } });
  listAiChallenges.mockResolvedValue([flagChallenge, eventChallenge]);
  getAiSolveCounts.mockResolvedValue(new Map([["a1", 3]]));
  getViewerAi.mockResolvedValue({ solved: {}, attempts: {} });
  getResolvedModules.mockResolvedValue([
    { id: "ai", title: "AI", blurb: "Prompt-injection and guardrail challenges." },
  ]);
  mintLaunchUrl.mockResolvedValue(MINTED_URL);
  // The passing default: no pre-event gate is active (or it has been
  // unlocked). The dedicated test below flips it.
  requireGatePassed.mockResolvedValue(true);
  // The passing default: a signed-in viewer already has a team, so the gate
  // never redirects. The dedicated test below overrides this to throw,
  // mimicking Next's own `redirect()` control-flow signal.
  redirectIfTeamless.mockResolvedValue(undefined);
  getAiHintIds.mockResolvedValue([]);
  getHintNotice.mockResolvedValue({ active: false, cost: 10 });
  getViewerHints.mockResolvedValue({ purchased: {}, classic: {}, ai: {}, spent: 0, count: 0 });
});

describe("ai challenge page gates", () => {
  it("404s when the ai module is not enabled", async () => {
    isModuleEnabled.mockReturnValue(false);
    await expect(AiChallengePage(params("a1"))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });

  it("404s for an unknown or deleted challenge id", async () => {
    await expect(AiChallengePage(params("nope"))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });

  // §6.6's gate-at-mint contract, which the API routes lean on and never
  // re-check. It was asserted but NOT enforced: `GATED_ROUTES` matches exact
  // paths, so proxy.ts covers `/ai` and never `/ai/<id>` — the one route that
  // mints. The page checks it itself now, and this is what says so.
  it("redirects an ungated visitor to /gate, and never mints", async () => {
    requireGatePassed.mockResolvedValue(false);

    await expect(AiChallengePage(params("a1"))).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
    await expect(AiChallengePage(params("a1"))).rejects.toMatchObject({
      digest: expect.stringContaining("/gate"),
    });
    expect(mintLaunchUrl).not.toHaveBeenCalled();
    // And nothing was loaded on the way there either — the check sits above
    // the data load, not between it and the mint.
    expect(listAiChallenges).not.toHaveBeenCalled();
  });

  it("never mints when the team gate would redirect a signed-in, teamless viewer", async () => {
    // Mirrors the shape `next/navigation`'s real `redirect()` throws — a
    // plain Error carrying a `NEXT_REDIRECT` digest — so this exercises the
    // same "the throw IS the control flow" path Next itself uses.
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/profile;307;",
    });
    redirectIfTeamless.mockRejectedValue(redirectError);

    await expect(AiChallengePage(params("a1"))).rejects.toBe(redirectError);
    // The mint happens BEHIND the team gate, not before it — a redirect that
    // fires must mean the mint never ran at all.
    expect(mintLaunchUrl).not.toHaveBeenCalled();
  });
});

describe("ai challenge page", () => {
  it("renders the challenge's title/category header and a way back", async () => {
    const html = renderToStaticMarkup(await AiChallengePage(params("a1")));
    expect(html).toContain("Prompt Leak");
    expect(html).toContain("Prompt Injection");
    expect(html).toContain('href="/ai"');

    // Points, solve count and the markdown-rendered description are
    // ChallengeDetail's own card to draw (pinned in its own test file) — this
    // page's job is only to hand it the right view model, checked here.
    expect(challengeDetailSpy).toHaveBeenCalledTimes(1);
    const [props] = challengeDetailSpy.mock.calls[0] as [{ challenge: { points: number; solveCount: number; description: string } }];
    expect(props.challenge.points).toBe(40);
    expect(props.challenge.solveCount).toBe(3);
    expect(props.challenge.description).toContain("**leak**");
  });

  it("decodes an encoded id from the URL", async () => {
    listAiChallenges.mockResolvedValue([{ ...flagChallenge, id: "web/one two" }]);
    getAiSolveCounts.mockResolvedValue(new Map());
    const html = renderToStaticMarkup(await AiChallengePage(params("web%2Fone%20two")));
    expect(html).toContain("Prompt Leak");
  });
});

describe("ai challenge page launcher", () => {
  it("mints and renders the launcher for a signed-in, teamed viewer", async () => {
    const html = renderToStaticMarkup(await AiChallengePage(params("a1")));

    expect(mintLaunchUrl).toHaveBeenCalledTimes(1);
    expect(mintLaunchUrl).toHaveBeenCalledWith({
      origin: expect.any(String),
      login: "alice",
      challenge: flagChallenge,
      challenges: [flagChallenge, eventChallenge],
      viewer: { solved: {}, attempts: {} },
    });

    expect(html).toContain(`href="${MINTED_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toMatch(/Open challenge/);
    expect(html).toContain("This link is yours — it signs you in on the challenge site.");
  });

  it("prompts sign-in instead of a launcher for a signed-out visitor, and never mints", async () => {
    getSession.mockResolvedValue(null);
    const html = renderToStaticMarkup(await AiChallengePage(params("a1")));

    expect(mintLaunchUrl).not.toHaveBeenCalled();
    expect(getViewerAi).not.toHaveBeenCalled();
    expect(html).toMatch(/sign in with github/i);
    expect(html).not.toContain(MINTED_URL);
    expect(html).not.toMatch(/open challenge/i);
  });

  it("renders the minted token exactly once — in the launcher href, nowhere else, never logged, never handed to a child component", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const html = renderToStaticMarkup(await AiChallengePage(params("a1")));

      const occurrences = html.split(MINTED_URL).length - 1;
      expect(occurrences).toBe(1);

      // The token substring alone (not just the whole URL) also appears once
      // in the SERIALIZED HTML — this would catch a second, differently-
      // formatted rendering of it there.
      expect(html.split("TESTTOKENVALUE123").length - 1).toBe(1);

      // The authored template's raw placeholder must never render, in any
      // form — that would mean the substitution was skipped somewhere.
      expect(html).not.toContain("{token}");

      // The html string alone cannot catch a token riding in a PROP that is
      // never rendered (react-dom/server only serializes what a component
      // actually returns) — so check what the page actually handed
      // <ChallengeDetail> too. Neither the full URL nor the bare token may
      // appear anywhere in its props.
      expect(challengeDetailSpy).toHaveBeenCalledTimes(1);
      const propsPayload = JSON.stringify(challengeDetailSpy.mock.calls);
      expect(propsPayload).not.toContain(MINTED_URL);
      expect(propsPayload).not.toContain("TESTTOKENVALUE123");

      // Nor logged, in any form — `console.error`/`warn`/`log` are the only
      // places this app is allowed to write, and none of them may ever carry
      // a live token.
      const consoleCalls = JSON.stringify([...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]);
      expect(consoleCalls).not.toContain(MINTED_URL);
      expect(consoleCalls).not.toContain("TESTTOKENVALUE123");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("derives the origin from BETTER_AUTH_URL, normalized to scheme+host+port — never a path", async () => {
    const prior = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_URL = "https://ctf.example.org/some/path?x=1";
    try {
      await AiChallengePage(params("a1"));
      expect(mintLaunchUrl).toHaveBeenCalledWith(expect.objectContaining({ origin: "https://ctf.example.org" }));
    } finally {
      if (prior === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = prior;
    }
  });

  // Proves the NEGATIVE, not just the fallback: the request carries a Host
  // (and a Forwarded/X-Forwarded-Host, the other two headers a caller
  // controls), `BETTER_AUTH_URL` is unset, and the origin is still the shipped
  // dev default. A `resolveOrigin` that reached for a header would put
  // `evil.test` in a signed token's `iss`.
  it("falls back to the configured default when BETTER_AUTH_URL is unset — never a caller-controlled Host header", async () => {
    const prior = process.env.BETTER_AUTH_URL;
    delete process.env.BETTER_AUTH_URL;
    headersRef.current = new Headers({
      host: "evil.test",
      "x-forwarded-host": "evil.test",
      forwarded: "host=evil.test;proto=https",
    });
    try {
      await AiChallengePage(params("a1"));
      expect(mintLaunchUrl).toHaveBeenCalledWith(expect.objectContaining({ origin: "http://localhost" }));
      const minted = JSON.stringify(mintLaunchUrl.mock.calls);
      expect(minted).not.toContain("evil.test");
    } finally {
      if (prior !== undefined) process.env.BETTER_AUTH_URL = prior;
      headersRef.current = new Headers();
    }
  });
});

describe("ai challenge page form", () => {
  // NOT a submitPath. `/api/ai/submit` authenticates the launch token, which
  // exists only in the launcher's href — so the in-box form goes through the
  // Server Action instead (spec §6.1's 2026-09-02 amendment). A regression to
  // `submitPath="/api/ai/submit"` is the dead form this pins against: that
  // route reads `{token, flag}` and 400s on the `{challengeId, flag}` body
  // the component's fetch path sends.
  it("renders ChallengeDetail wired to the server action — never to a submit route — for a flag-mode challenge", async () => {
    renderToStaticMarkup(await AiChallengePage(params("a1")));
    expect(challengeDetailSpy).toHaveBeenCalledTimes(1);
    const [props] = challengeDetailSpy.mock.calls[0] as [
      { submitPath?: string; submitAction?: unknown; authenticated: boolean },
    ];
    expect(typeof props.submitAction).toBe("function");
    expect(props.submitPath).toBeUndefined();
    expect(props.authenticated).toBe(true);
  });

  it("renders ChallengeDetail for a both-mode challenge too", async () => {
    listAiChallenges.mockResolvedValue([{ ...flagChallenge, id: "a3", mode: "both" as const }]);
    renderToStaticMarkup(await AiChallengePage(params("a3")));
    expect(challengeDetailSpy).toHaveBeenCalledTimes(1);
  });

  it("renders no ChallengeDetail at all for an event-mode challenge — the launcher is the whole page", async () => {
    const html = renderToStaticMarkup(await AiChallengePage(params("a2")));
    expect(challengeDetailSpy).not.toHaveBeenCalled();
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    // The launcher still renders — an event-only challenge has no in-box
    // form, not no page.
    expect(html).toContain(`href="${MINTED_URL}"`);
  });
});

describe("ai challenge page view model", () => {
  it("derives the viewer's solved state through the same rule as the board, and hands it to ChallengeDetail", async () => {
    getViewerAi.mockResolvedValue({
      solved: { a1: { points: 40, at: "2026-08-18T00:00:00.000Z", source: "flag" } },
      attempts: {},
    });
    renderToStaticMarkup(await AiChallengePage(params("a1")));
    expect(challengeDetailSpy).toHaveBeenCalledTimes(1);
    const [props] = challengeDetailSpy.mock.calls[0] as [{ challenge: { status: string; earnedPoints?: number } }];
    expect(props.challenge).toMatchObject({ status: "solved", earnedPoints: 40 });
  });

  it("derives an active cooldown, without leaking the raw instant into the page's own markup", async () => {
    getViewerAi.mockResolvedValue({
      solved: {},
      attempts: { a1: { attempts: 1, lastAt: new Date().toISOString() } },
    });
    const html = renderToStaticMarkup(await AiChallengePage(params("a1")));
    const [props] = challengeDetailSpy.mock.calls[0] as [{ challenge: { status: string; retryAt?: string } }];
    expect(props.challenge.status).toBe("cooldown");
    expect(typeof props.challenge.retryAt).toBe("string");
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  // The view model is built field by field — nothing beyond the public
  // AiChallenge fields, this challenge's solve count and the derived status
  // may reach the markup OR <ChallengeDetail>'s props, whatever the store
  // record carries.
  it("never lets the launch template or an unexpected store field reach the markup or ChallengeDetail's props", async () => {
    listAiChallenges.mockResolvedValue([
      // A defense-in-depth check: even if a future bug had the store hand
      // back extra fields no `AiChallenge` should ever carry, the page's
      // field-by-field view model must not surface them.
      { ...flagChallenge, flag: "CTF{never-render-me}", signingKey: "aik_never-render-me" } as unknown as typeof flagChallenge,
    ]);
    const html = renderToStaticMarkup(await AiChallengePage(params("a1")));
    expect(html).not.toContain("CTF{never-render-me}");
    expect(html).not.toContain("aik_never-render-me");
    expect(html).not.toContain(flagChallenge.urlTemplate);

    const propsPayload = JSON.stringify(challengeDetailSpy.mock.calls);
    expect(propsPayload).not.toContain("CTF{never-render-me}");
    expect(propsPayload).not.toContain("aik_never-render-me");
  });
});

// The paid hint (issue #211, mirrors flags/[id]'s #190 suite): availability
// is public, the TEXT is not — it renders only for the viewer who bought it,
// and the affordance never 401s a signed-out visitor. Sits outside
// <ChallengeDetail>'s spy, so these are real markup assertions.
describe("ai challenge page hint", () => {
  beforeEach(() => {
    getAiHintIds.mockResolvedValue(["a1"]);
    getHintNotice.mockResolvedValue({ active: true, cost: 25 });
  });

  it("offers the reveal button (with the price) to a signed-in non-owner", async () => {
    const html = renderToStaticMarkup(await AiChallengePage(params("a1")));
    expect(html).toMatch(/Reveal hint \(−25 pts\)/);
  });

  it("renders an owned hint's text server-side, with no buy button", async () => {
    getViewerHints.mockResolvedValue({ purchased: {}, classic: {}, ai: { a1: "Try the system prompt." }, spent: 25, count: 1 });
    const html = renderToStaticMarkup(await AiChallengePage(params("a1")));
    expect(html).toContain("Try the system prompt.");
    expect(html).not.toMatch(/Reveal hint/);
  });

  it("tells a signed-out visitor a hint exists without an affordance that would 401", async () => {
    getSession.mockResolvedValue(null);
    const html = renderToStaticMarkup(await AiChallengePage(params("a1")));
    expect(html).toContain("sign in to reveal it");
    expect(html).not.toMatch(/Reveal hint \(/);
    expect(getViewerHints).not.toHaveBeenCalled();
  });

  it("renders no hint layer at all when hints are off or the challenge has none", async () => {
    getHintNotice.mockResolvedValue({ active: false, cost: 25 });
    const off = renderToStaticMarkup(await AiChallengePage(params("a1")));
    expect(off).not.toContain("💡");
    getHintNotice.mockResolvedValue({ active: true, cost: 25 });
    getAiHintIds.mockResolvedValue([]);
    const none = renderToStaticMarkup(await AiChallengePage(params("a1")));
    expect(none).not.toContain("💡");
  });

  // The one thing this module's hint block does differently from classic's:
  // it renders for an event-mode challenge too, where <ChallengeDetail> does
  // NOT — a hint about an externally hosted challenge is still a hint.
  it("still offers the hint on an event-mode challenge, which has no ChallengeDetail at all", async () => {
    getAiHintIds.mockResolvedValue(["a2"]);
    const html = renderToStaticMarkup(await AiChallengePage(params("a2")));
    expect(challengeDetailSpy).not.toHaveBeenCalled();
    expect(html).toMatch(/Reveal hint \(−25 pts\)/);
  });
});

describe("ai challenge page metadata", () => {
  it("titles the page after the challenge, with a neutral description", async () => {
    const meta = await generateMetadata(params("a1"));
    expect(meta.title).toBe("Prompt Leak");
    expect(meta.description).toBe("Prompt Injection · 40 points.");
    expect(JSON.stringify(meta)).not.toContain("leak its system prompt");
  });

  it("stays empty for an unknown id or a disabled module", async () => {
    expect(await generateMetadata(params("nope"))).toEqual({});
    isModuleEnabled.mockReturnValue(false);
    expect(await generateMetadata(params("a1"))).toEqual({});
  });
});
