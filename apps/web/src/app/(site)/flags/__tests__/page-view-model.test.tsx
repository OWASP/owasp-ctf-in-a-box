// The keyless-contestant guarantee, pinned at the PAGE level, mirroring
// quiz/__tests__/page-view-model.test.tsx exactly.
//
// challenge-board.test.tsx already proves <ChallengeBoard> won't echo a leaked
// field into markup even if one somehow reaches it. This proves the field
// never reaches it in the first place: whatever `listChallenges()` hands
// back, /flags's view model is built field by field from the public
// `Challenge` shape, so a flag cannot ride along.
//
// ChallengeBoard is mocked here (unlike page.test.tsx, which renders it for
// real) purely to capture the props it is handed — the view model itself,
// before any rendering can hide a field. Checking the rendered HTML instead
// would prove nothing here: <ChallengeBoard>/<ChallengeCard> only ever reads a
// fixed whitelist of props, so a leaked field never reaches markup EVEN IF
// the page spread a raw store record into the view model — the safety net
// one level down would silently absorb the very mutation this test exists to
// catch. Capturing props is what makes the page's own field-by-field
// construction the thing under test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { isModuleEnabled, getSession, listChallenges, listCategories, getSolveCounts, getViewerClassic, getAdminSettings, getResolvedModules } =
  vi.hoisted(() => ({
    isModuleEnabled: vi.fn(),
    getSession: vi.fn(),
    listChallenges: vi.fn(),
    listCategories: vi.fn(),
    getSolveCounts: vi.fn(),
    getViewerClassic: vi.fn(),
    getAdminSettings: vi.fn(),
    getResolvedModules: vi.fn(),
  }));

const captured: { challenges: Record<string, unknown>[] } = { challenges: [] };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
// Runtime admin grants (issue #147) put a Redis read behind the page's
// admin-link check for any signed-in viewer. Mocked to empty here: this suite
// is about the view model's fields, and an unmocked SMEMBERS turns it into a
// test of the datastore.
vi.mock("@/lib/admin-admins", () => ({ listStoredAdmins: async () => [] }));

vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("@/lib/modules", () => ({ isModuleEnabled }));
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings }));
vi.mock("@/lib/classic-store", () => ({
  listChallenges,
  listCategories,
  getSolveCounts,
  getViewerClassic,
  CLASSIC_COOLDOWN_SEC: 5,
}));
vi.mock("@/components/challenge-board", () => ({
  default: (props: { challenges: Record<string, unknown>[] }) => {
    captured.challenges = props.challenges;
    return null;
  },
}));

import FlagsPage from "@/app/(site)/flags/page";

// Distinctive enough that finding it anywhere in the view model is proof of a
// leak rather than a coincidental substring.
const LEAKED_FLAG = "CTF{leaked-flag-zz9}";

/** A store record that HAS leaked — the shape a hypothetical admin-facing
 *  reader might return flattened, plus a plausible normalized-flag field.
 *  The page must strip every one of them, because it copies the fields it
 *  wants rather than spreading what it was given. */
const leakyRecord = {
  id: "c1",
  title: "SQLi 101",
  category: "Web",
  description: "Find the flag.",
  points: 50,
  order: 1,
  flag: LEAKED_FLAG,
  flagnorm: LEAKED_FLAG.toLowerCase(),
};

beforeEach(() => {
  vi.clearAllMocks();
  captured.challenges = [];
  isModuleEnabled.mockReturnValue(true);
  getSession.mockResolvedValue({ user: { login: "alice" } });
  getViewerClassic.mockResolvedValue({ solved: {}, attempts: {} });
  getAdminSettings.mockResolvedValue({ classicCooldownSec: 5 });
  listCategories.mockResolvedValue(["Web"]);
  getSolveCounts.mockResolvedValue(new Map());
  getResolvedModules.mockResolvedValue([
    { id: "classic", title: "Jeopardy", blurb: "Find the flag, submit the string, take the points." },
  ]);
});

describe("/flags view model", () => {
  it("carries no flag field, even when the store hands it one", async () => {
    listChallenges.mockResolvedValue([leakyRecord]);

    renderToStaticMarkup(await FlagsPage());

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
    expect(Object.keys(view)).not.toContain("flag");
    expect(Object.keys(view)).not.toContain("flagnorm");
  });

  it("exposes exactly the public fields plus the derived per-viewer status and solve count", async () => {
    // Pins the whitelist itself: a future field added by a spread rather than
    // copied on purpose fails here even if it isn't named "flag".
    listChallenges.mockResolvedValue([leakyRecord]);

    renderToStaticMarkup(await FlagsPage());

    // `caseSensitive` joined this list in #193 and is public ON PURPOSE: the
    // board has to tell a contestant that capitalisation matters, and knowing
    // that reveals nothing about the answer. It is copied by name in the page's
    // map like every other field here, which is what this test exists to force.
    expect(Object.keys(captured.challenges[0]).sort()).toEqual(
      ["caseSensitive", "category", "description", "id", "points", "solveCount", "status", "title"].sort(),
    );
  });
});
// The same guarantee one level down — that <ChallengeBoard> won't echo a
// leaked field into markup even if one did reach it — is
// challenge-board.test.tsx's "never lets a flag reach the markup" test. The two
// guards are independent on purpose; neither is allowed to be the only one.
