// The keyless-contestant guarantee, pinned at the PAGE level, mirroring
// flags/__tests__/page-view-model.test.tsx exactly.
//
// <ChallengeBoard> is mocked here (unlike page.test.tsx, which renders it for
// real) purely to capture the props it is handed — the view model itself,
// before any rendering can hide a field. Checking the rendered HTML instead
// would prove nothing here: <ChallengeBoard> only ever reads a fixed
// whitelist of props, so a leaked field never reaches markup EVEN IF the page
// spread a raw store record into the view model — the safety net one level
// down would silently absorb the very mutation this test exists to catch.
// Capturing props is what makes the page's own field-by-field construction
// the thing under test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const {
  isModuleEnabled,
  getSession,
  listAiChallenges,
  listAiCategories,
  getAiSolveCounts,
  getViewerAi,
  getAdminSettings,
  getResolvedModules,
  redirectIfTeamless,
} = vi.hoisted(() => ({
  isModuleEnabled: vi.fn(),
  getSession: vi.fn(),
  listAiChallenges: vi.fn(),
  listAiCategories: vi.fn(),
  getAiSolveCounts: vi.fn(),
  getViewerAi: vi.fn(),
  getAdminSettings: vi.fn(),
  getResolvedModules: vi.fn(),
  redirectIfTeamless: vi.fn(),
}));

const captured: { challenges: Record<string, unknown>[] } = { challenges: [] };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
// Runtime admin grants (issue #147) put a Redis read behind the page's
// admin-link check for any signed-in viewer. Mocked to empty here: this suite
// is about the view model's fields, and an unmocked SMEMBERS turns it into a
// test of the datastore.
vi.mock("@/lib/admin-admins", () => ({ listStoredAdmins: async () => [] }));
// Same reasoning as the admin-grants mock above, for the team redirect: with
// TEAM_WRITES_ENABLED=true this is a real team-store lookup, and this suite
// has no business depending on that runtime flag. Same idiom as the `[id]`
// page's own suite.
vi.mock("@/lib/require-team", () => ({ redirectIfTeamless }));

vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("@/lib/modules", () => ({ isModuleEnabled }));
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings }));
vi.mock("@/lib/ai-store", () => ({
  listAiChallenges,
  listAiCategories,
  getAiSolveCounts,
  getViewerAi,
  AI_COOLDOWN_SEC: 5,
}));
vi.mock("@/components/challenge-board", () => ({
  default: (props: { challenges: Record<string, unknown>[] }) => {
    captured.challenges = props.challenges;
    return null;
  },
}));

import AiPage from "@/app/(site)/ai/page";

// Distinctive enough that finding it anywhere in the view model is proof of a
// leak rather than a coincidental substring.
const LEAKED_FLAG = "CTF{leaked-ai-flag-zz9}";
const LEAKED_SIGNING_KEY = "sk_leaked_signing_key";

/** A store record that HAS leaked — the shape a hypothetical admin-facing
 *  reader might return flattened, plus plausible normalized-flag and
 *  signing-key fields. ai carries a FOURTH secret classic does not (the
 *  per-challenge event signing key — see ai-store.ts's secrecy-boundary
 *  note), so this poisons that field too, not just `flag`/`flagnorm`. The
 *  page must strip every one of them, because it copies the fields it wants
 *  rather than spreading what it was given. */
const leakyRecord = {
  id: "a1",
  title: "Prompt leak 101",
  category: "Prompt Injection",
  description: "Find the flag.",
  points: 50,
  order: 1,
  mode: "flag",
  urlTemplate: "https://example.test/play?token={token}",
  flag: LEAKED_FLAG,
  flagnorm: LEAKED_FLAG.toLowerCase(),
  signingKey: LEAKED_SIGNING_KEY,
};

beforeEach(() => {
  vi.clearAllMocks();
  captured.challenges = [];
  isModuleEnabled.mockReturnValue(true);
  getSession.mockResolvedValue({ user: { login: "alice" } });
  getViewerAi.mockResolvedValue({ solved: {}, attempts: {} });
  getAdminSettings.mockResolvedValue({ aiCooldownSec: null });
  listAiCategories.mockResolvedValue(["Prompt Injection"]);
  getAiSolveCounts.mockResolvedValue(new Map());
  redirectIfTeamless.mockResolvedValue(undefined);
  getResolvedModules.mockResolvedValue([
    {
      id: "ai",
      title: "AI",
      blurb: "Prompt-injection and guardrail challenges hosted outside the box, scored inside it.",
    },
  ]);
});

describe("/ai view model", () => {
  it("carries no flag or signing-key field, even when the store hands it one", async () => {
    listAiChallenges.mockResolvedValue([leakyRecord]);

    renderToStaticMarkup(await AiPage());

    // Non-vacuity first: the challenge really did make it into the view
    // model. Without this, an empty list would satisfy every assertion below
    // while proving nothing.
    expect(captured.challenges).toHaveLength(1);
    expect(captured.challenges[0].title).toBe(leakyRecord.title);

    const view = captured.challenges[0];
    // Serialised first, and on the VALUE rather than the field name: this is
    // the assertion that still catches a leak arriving under a field nobody
    // thought to blacklist, or nested inside one.
    expect(JSON.stringify(view)).not.toContain(LEAKED_FLAG);
    expect(JSON.stringify(view)).not.toContain(LEAKED_FLAG.toLowerCase());
    expect(JSON.stringify(view)).not.toContain(LEAKED_SIGNING_KEY);
    expect(Object.keys(view)).not.toContain("flag");
    expect(Object.keys(view)).not.toContain("flagnorm");
    expect(Object.keys(view)).not.toContain("signingKey");
  });

  it("exposes exactly the public board fields plus the derived per-viewer status and solve count", async () => {
    // Pins the whitelist itself: a future field added by a spread rather than
    // copied on purpose fails here even if it isn't named "flag" — this also
    // proves `urlTemplate`/`mode` (public, but board-irrelevant) don't ride
    // along either, since the board tile never reads them.
    listAiChallenges.mockResolvedValue([leakyRecord]);

    renderToStaticMarkup(await AiPage());

    expect(Object.keys(captured.challenges[0]).sort()).toEqual(
      ["caseSensitive", "category", "description", "id", "points", "solveCount", "status", "title"].sort(),
    );
  });

  // The organizer override, read through the page exactly like classic's
  // `classicCooldownSec` — see flags/__tests__/page-view-model.test.tsx's
  // sibling coverage. AI_COOLDOWN_SEC is mocked to 5s above: an attempt 8s
  // old would already have cleared the module default, so a status of
  // "cooldown" here is proof the page used the 12s override, not the default.
  it("derives cooldown status from the aiCooldownSec admin override, not the module default", async () => {
    listAiChallenges.mockResolvedValue([
      { id: "a1", title: "Prompt leak 101", category: "Prompt Injection", description: "d", points: 50, order: 1, mode: "flag" },
    ]);
    getAdminSettings.mockResolvedValue({ aiCooldownSec: 12 });
    getViewerAi.mockResolvedValue({
      solved: {},
      attempts: { a1: { attempts: 1, lastAt: new Date(Date.now() - 8_000).toISOString() } },
    });

    renderToStaticMarkup(await AiPage());

    expect(captured.challenges[0].status).toBe("cooldown");
  });
});
// The same guarantee one level down — that <ChallengeBoard> won't echo a
// leaked field into markup even if one did reach it — is
// challenge-board.test.tsx's own coverage.
// The two guards are independent on purpose; neither is allowed to be the
// only one.
