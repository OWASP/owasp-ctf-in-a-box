// The dedicated challenge page (issue #208) — where the description and the
// flag form live now. Same static-render pattern and mock set as the board
// page's suite; the pins that matter here: the 404 gates (module off,
// unknown id), the view model deriving the same states the board derives,
// and the flag having no path into the markup.
import { beforeEach, describe, expect, it, vi } from "vitest";
// #464 pre-launch lock: launched by default in this file; the "pre-launch
// lock" test below drives the refused path. The lock itself is unit-tested in
// lib/__tests__/launch.test.ts.
const launchLock = vi.hoisted(() => ({
  redirectIfNotLaunched: vi.fn(async () => ({ allowed: true, preview: false })),
  getLaunchAccess: vi.fn(async () => ({ allowed: true, preview: false })),
}));
vi.mock("@/lib/launch", () => launchLock);
import { renderToStaticMarkup } from "react-dom/server";

const { isModuleEnabled, isAdminLogin, getSession, listChallenges, getSolveCounts, getViewerClassic, getAdminSettings, getResolvedModules, getClassicHintIds, getHintNotice, getViewerHints } =
  vi.hoisted(() => ({
    isModuleEnabled: vi.fn(),
    isAdminLogin: vi.fn(),
    getSession: vi.fn(),
    listChallenges: vi.fn(),
    getSolveCounts: vi.fn(),
    getViewerClassic: vi.fn(),
    getAdminSettings: vi.fn(),
    getResolvedModules: vi.fn(),
    getClassicHintIds: vi.fn(),
    getHintNotice: vi.fn(),
    getViewerHints: vi.fn(),
  }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
// ClassicChallenge calls useRouter for its post-submit refresh.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/modules", () => ({ isModuleEnabled }));
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/admin-auth", () => ({ isAdminLogin }));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings }));
vi.mock("@/lib/hint-store", () => ({ getClassicHintIds, getHintNotice, getViewerHints }));
// #463 stories: none by default; the story tests below set some.
const storyMocks = vi.hoisted(() => ({
  listStories: vi.fn(async () => [] as { id: string; title: string; intro: string; steps: string[] }[]),
  getTeamClassicSolvedIds: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/lib/classic-team", () => ({ getTeamClassicSolvedIds: storyMocks.getTeamClassicSolvedIds }));
vi.mock("@/lib/classic-store", () => ({
  listStories: storyMocks.listStories,
  listChallenges,
  getSolveCounts,
  getViewerClassic,
  CLASSIC_COOLDOWN_SEC: 5,
}));

// #186 attachments: none by default.
const attachmentMocks = vi.hoisted(() => ({ listAttachments: vi.fn(async () => [] as Record<string, unknown>[]) }));
vi.mock("@/lib/attachments-store", () => attachmentMocks);

import ClassicChallengePage, { generateMetadata } from "@/app/(site)/flags/[id]/page";

// The store record carries grading material alongside the public fields —
// exactly what the page must never spread into props.
const record = {
  id: "c1",
  title: "Robots Only",
  category: "Recon",
  description: "Check `/robots.txt` — **nothing** is truly hidden.",
  points: 50,
  order: 0,
  caseSensitive: true,
  flag: "CTF{never-render-me}",
  flagnorm: "ctf{never-render-me}",
};

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  isModuleEnabled.mockReturnValue(true);
  isAdminLogin.mockReturnValue(false);
  getSession.mockResolvedValue({ user: { login: "alice" } });
  listChallenges.mockResolvedValue([record]);
  getSolveCounts.mockResolvedValue(new Map([["c1", 7]]));
  getViewerClassic.mockResolvedValue({ solved: {}, attempts: {} });
  getAdminSettings.mockResolvedValue({ classicCooldownSec: 300 });
  getResolvedModules.mockResolvedValue([
    { id: "classic", title: "Jeopardy", blurb: "Find the flag, submit the string, take the points." },
  ]);
  getClassicHintIds.mockResolvedValue([]);
  getHintNotice.mockResolvedValue({ active: false, cost: 10 });
  getViewerHints.mockResolvedValue({ purchased: {}, classic: {}, spent: 0, count: 0 });
});

describe("challenge page gates", () => {
  it("404s when the classic module is not enabled", async () => {
    isModuleEnabled.mockReturnValue(false);
    await expect(ClassicChallengePage(params("c1"))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });

  it("404s for an unknown or deleted challenge id", async () => {
    await expect(ClassicChallengePage(params("nope"))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });
});

describe("challenge page", () => {
  it("renders the challenge with its meta, description and form — and a way back", async () => {
    const html = renderToStaticMarkup(await ClassicChallengePage(params("c1")));
    expect(html).toContain("Robots Only");
    expect(html).toContain("Recon");
    expect(html).toContain("50 pts");
    expect(html).toContain("7 solve");
    expect(html).toMatch(/case-sensitive/i);
    // Markdown rendered, not echoed raw.
    expect(html).toMatch(/<strong[^>]*>nothing<\/strong>/);
    expect(html).toMatch(/submit flag/i);
    expect(html).toContain('href="/flags"');
  });

  it("decodes an encoded id from the URL", async () => {
    listChallenges.mockResolvedValue([{ ...record, id: "web/one two" }]);
    getSolveCounts.mockResolvedValue(new Map());
    const html = renderToStaticMarkup(await ClassicChallengePage(params("web%2Fone%20two")));
    expect(html).toContain("Robots Only");
  });

  it("derives the viewer's solved state through the same rule as the board", async () => {
    getViewerClassic.mockResolvedValue({
      solved: { c1: { points: 50, at: "2026-08-18T00:00:00.000Z" } },
      attempts: {},
    });
    const html = renderToStaticMarkup(await ClassicChallengePage(params("c1")));
    expect(html).toMatch(/solved.*earned 50 point/i);
    expect(html).not.toMatch(/submit flag/i);
  });

  it("derives an active cooldown, without leaking the raw instant", async () => {
    getViewerClassic.mockResolvedValue({
      solved: {},
      attempts: { c1: { attempts: 1, lastAt: new Date().toISOString() } },
    });
    const html = renderToStaticMarkup(await ClassicChallengePage(params("c1")));
    expect(html).toMatch(/on cooldown/i);
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("prompts a signed-out visitor instead of offering the form, and never reads their progress", async () => {
    getSession.mockResolvedValue(null);
    const html = renderToStaticMarkup(await ClassicChallengePage(params("c1")));
    expect(getViewerClassic).not.toHaveBeenCalled();
    expect(html).toMatch(/sign in with github/i);
    expect(html).not.toContain("<button");
  });

  // The view model is built field by field — the record's grading material
  // must have NO path into the markup, whatever the record carries.
  it("never lets the flag reach the markup", async () => {
    const html = renderToStaticMarkup(await ClassicChallengePage(params("c1")));
    expect(html).not.toContain("CTF{never-render-me}");
    expect(html).not.toContain("ctf{never-render-me}");
  });
});

// The paid hint (#190): availability is public, the TEXT is not — it renders
// only for the viewer who bought it, and the affordance never 401s a
// signed-out visitor.
describe("challenge page files (#186)", () => {
  it("lists the challenge's files — never their hash or chunk bookkeeping", async () => {
    attachmentMocks.listAttachments.mockResolvedValueOnce([
      { id: "a0123456789abcdef", kind: "upload", name: "capture.pcap", size: 2048, sha256: "e".repeat(64), chunks: 1 },
      { id: "a0123456789abcdee", kind: "link", name: "disk.img", url: "https://files.example.org/disk.img" },
    ]);
    const html = renderToStaticMarkup(await ClassicChallengePage(params("c1")));
    expect(attachmentMocks.listAttachments).toHaveBeenCalledWith("classic", "c1");
    expect(html).toContain('href="/api/attachments/a0123456789abcdef"');
    expect(html).toContain("disk.img");
    expect(html).not.toContain("e".repeat(64));
  });

  it("renders no Files section for a challenge without any", async () => {
    const html = renderToStaticMarkup(await ClassicChallengePage(params("c1")));
    expect(html).not.toContain(">Files<");
  });
});

describe("challenge page hint", () => {
  beforeEach(() => {
    getClassicHintIds.mockResolvedValue(["c1"]);
    getHintNotice.mockResolvedValue({ active: true, cost: 25 });
  });

  it("offers the reveal button (with the price) to a signed-in non-owner", async () => {
    const html = renderToStaticMarkup(await ClassicChallengePage(params("c1")));
    expect(html).toMatch(/Reveal hint \(−25 pts\)/);
  });

  it("renders an owned hint's text server-side, with no buy button", async () => {
    getViewerHints.mockResolvedValue({ purchased: {}, classic: { c1: "Look at robots.txt." }, spent: 25, count: 1 });
    const html = renderToStaticMarkup(await ClassicChallengePage(params("c1")));
    expect(html).toContain("Look at robots.txt.");
    expect(html).not.toMatch(/Reveal hint/);
  });

  it("tells a signed-out visitor a hint exists without an affordance that would 401", async () => {
    getSession.mockResolvedValue(null);
    const html = renderToStaticMarkup(await ClassicChallengePage(params("c1")));
    expect(html).toContain("sign in to reveal it");
    expect(html).not.toMatch(/Reveal hint \(/);
    expect(getViewerHints).not.toHaveBeenCalled();
  });

  it("renders no hint layer at all when hints are off or the challenge has none", async () => {
    getHintNotice.mockResolvedValue({ active: false, cost: 25 });
    const off = renderToStaticMarkup(await ClassicChallengePage(params("c1")));
    expect(off).not.toContain("💡");
    getHintNotice.mockResolvedValue({ active: true, cost: 25 });
    getClassicHintIds.mockResolvedValue([]);
    const none = renderToStaticMarkup(await ClassicChallengePage(params("c1")));
    expect(none).not.toContain("💡");
  });
});

describe("challenge page metadata", () => {
  it("titles the page after the challenge, with a neutral description", async () => {
    const meta = await generateMetadata(params("c1"));
    expect(meta.title).toBe("Robots Only");
    expect(meta.description).toBe("Recon · 50 points.");
    // The organizer-authored description is challenge CONTENT, not metadata.
    expect(JSON.stringify(meta)).not.toContain("robots.txt");
  });

  it("stays empty for an unknown id or a disabled module", async () => {
    expect(await generateMetadata(params("nope"))).toEqual({});
    isModuleEnabled.mockReturnValue(false);
    expect(await generateMetadata(params("c1"))).toEqual({});
  });
});

describe("pre-launch lock (#464)", () => {
  it("sends a refused viewer to the landing page before loading any content", async () => {
    launchLock.redirectIfNotLaunched.mockImplementationOnce(async () => {
      throw new Error("NEXT_REDIRECT:/");
    });
    await expect(ClassicChallengePage(params("c1"))).rejects.toThrow("NEXT_REDIRECT:/");
    expect(listChallenges).not.toHaveBeenCalled();
  });
});

describe("generateMetadata before launch (#464)", () => {
  // Metadata runs on its own path — a flight/soft-nav response can carry it
  // next to the page's redirect — so it must not read or return challenge
  // content (title, category, points) for a refused viewer.
  it("returns no metadata and reads no challenge list when the viewer is refused", async () => {
    launchLock.getLaunchAccess.mockResolvedValueOnce({ allowed: false, preview: false });
    expect(await generateMetadata(params("x"))).toEqual({});
    expect(listChallenges).not.toHaveBeenCalled();
  });
});

describe("a locked story step's own page (#463)", () => {
  beforeEach(() => {
    // "recon" must be a real challenge: a story step that doesn't exist is
    // skipped (it can't lock the step after it — review I2).
    listChallenges.mockResolvedValue([{ ...record, id: "recon", title: "Recon" }, record]);
    storyMocks.listStories.mockResolvedValue([{ id: "op", title: "Op", intro: "", steps: ["recon", "c1"] }]);
    storyMocks.getTeamClassicSolvedIds.mockResolvedValue(new Set());
  });

  it("is a 404 — the same as an unknown id, revealing nothing", async () => {
    await expect(ClassicChallengePage(params("c1"))).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });

  it("has no metadata (no title or points leak through the <title>)", async () => {
    expect(await generateMetadata(params("c1"))).toEqual({});
  });

  it("renders normally once the team has solved the step before it", async () => {
    storyMocks.getTeamClassicSolvedIds.mockResolvedValue(new Set(["recon"]));
    expect(renderToStaticMarkup(await ClassicChallengePage(params("c1")))).toContain(record.title);
  });
});
