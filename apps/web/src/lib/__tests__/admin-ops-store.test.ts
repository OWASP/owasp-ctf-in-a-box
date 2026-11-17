// Per-contestant and per-team support operations (issue #168).
//
// These are the only destructive controls in the kit that act on ONE person,
// so the things worth pinning are the blast radius (does it touch anybody
// else?), the aggregate bookkeeping (the counters are NOT all keyed the same
// way), and the refusals that keep a team administrable.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashEval: vi.fn<(script: string, keys: string[], args: (string | number)[]) => Promise<unknown>>(),
  // `error` is part of the shape: upstashPipeline reports a per-command
  // failure there, and the tests below drive exactly that (issue #358).
  upstashPipeline: vi.fn<(commands: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
}));

vi.mock("server-only", () => ({}));
// `parseScanPage` is the REAL parser (pure: a reply in, a page or a throw
// out). Stubbing it here would put a local imitation under test instead of
// the one the store calls.
vi.mock("@/lib/upstash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/upstash")>();
  return {
    assertPipelineOk: actual.assertPipelineOk,
    parseScanPage: actual.parseScanPage,
    upstashEval: mocks.upstashEval,
    upstashPipeline: mocks.upstashPipeline,
  };
});
// deleteAllAccounts runs the master reset and sweeps the account namespaces
// through the reset's own SCAN+DEL walk.
const storeDeps = vi.hoisted(() => ({ resetEvent: vi.fn(), scanDelByPrefix: vi.fn() }));
vi.mock("@/lib/admin-store", () => ({ ADMIN_AUDIT_KEY: "ctf:admin:audit", AUDIT_CAP: 500, ...storeDeps }));
// deleteUser refuses an organizer before anything is written.
const grantDeps = vi.hoisted(() => ({ isAdminGrantee: vi.fn() }));
vi.mock("@/lib/admin-grants", () => ({ ADMIN_GRANTS_KEY: "ctf:admin:grants", ...grantDeps }));
// #553: a per-player reset lowers that player's score; the store brackets
// its writes with the leaf's begin/end (shared in-progress marker + revision
// bump) so no app task charges a hint against a gross the reset is removing.
const foldCache = vi.hoisted(() => ({ beginScoreLowering: vi.fn(), endScoreLowering: vi.fn() }));
vi.mock("@/lib/leaderboard/fold-cache", () => foldCache);
// #597: the admin add/move reads the team-size cap and writes the activity log.
const teamDeps = vi.hoisted(() => ({ resolveTeamMaxMembers: vi.fn(async () => 4), logActivity: vi.fn(async () => {}) }));
vi.mock("@/lib/team-store", () => ({ resolveTeamMaxMembers: teamDeps.resolveTeamMaxMembers }));
vi.mock("@/lib/activity-log", () => ({ logActivity: teamDeps.logActivity }));
// Profiles name the subject on the card and prove an add targets a real
// account. The id regex is the real one.
const playerDeps = vi.hoisted(() => ({ getPlayerProfiles: vi.fn() }));
vi.mock("@/lib/player", () => ({
  PLAYER_ID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  displayNameOf: (r: { id: string; login?: string }) => r.login || `player ${r.id.slice(0, 8)}`,
  getPlayerProfiles: playerDeps.getPlayerProfiles,
}));

// deleteUser reads the player's link once to name the held-score keys to clear.
// unlinkGithub releases it.
const linkDeps = vi.hoisted(() => ({ getGithubLink: vi.fn(), releaseGithubLink: vi.fn() }));
vi.mock("@/lib/github-link", () => linkDeps);

// unlinkGithub reads and deletes the player's better-auth account rows;
// deleteUser removes the user row, its accounts and its sessions.
const authDeps = vi.hoisted(() => ({
  findAccounts: vi.fn(),
  deleteAccount: vi.fn(),
  findUserById: vi.fn(),
  deleteUserSessions: vi.fn(),
  deleteAccounts: vi.fn(),
  deleteUser: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: { $context: Promise.resolve({ internalAdapter: authDeps }) } }));

// renameUser reads the old username and writes the new one through the
// username store (the auth adapter), which these suites do not stand up.
const nameDeps = vi.hoisted(() => ({ renameUsername: vi.fn(), currentUsername: vi.fn() }));
vi.mock("@/lib/username-store", () => nameDeps);

import {
  CLEAR_HELD_SCRIPT,
  OpsValidationError,
  deleteAllAccounts,
  deleteUser,
  forceAddToTeam,
  forceDisbandTeam,
  forceRemoveFromTeam,
  forceTransferCaptain,
  lookupUser,
  renameUser,
  requirePlayerId,
  resetUserProgress,
  unlinkGithub,
} from "@/lib/admin-ops-store";

const OCTO = "0c7aca70-0000-4000-8000-00000000000a";
const BOB = "b0b00000-0000-4000-8000-00000000000d";
const ADMIN = { id: "ad000000-0000-4000-8000-000000000001", name: "admin" };
const ALICE_ACTOR = { id: "a11ce000-0000-4000-8000-00000000000c", name: "alice" };
const profile = (id: string, login: string) => ({ id, name: login, image: null, githubLogin: login });

/** Reply for a pipeline of N commands, all zero/empty unless overridden. */
const replies = (...results: unknown[]) => results.map((result) => ({ result }));

/** lookupUser's first command is one HMGET of [team, joinedAt, firstTeamAt],
 *  so its reply is an ARRAY, not a scalar. Building it here keeps every
 *  fixture honest about that — an accidental scalar makes the store read no
 *  team at all and silently skips the follow-up pipeline, which then eats the
 *  NEXT test's queued reply. */
const userHmget = (
  slug: string | null,
  joinedAt: string | null = null,
  firstTeamAt: string | null = null,
) => [slug, joinedAt, firstTeamAt];

/** The SCAN over `ctf:solves:*` that the secure-dev walk does first. Queues an
 *  empty sweep: cursor "0", no keys. */
function mockNoSecureDevKeys() {
  mocks.upstashPipeline.mockResolvedValueOnce(replies(["0", []]));
}

/** A single-page SCAN returning one solves hash whose fields are `fields`. */
function mockSecureDevKeys(key: string, fields: string[]) {
  mocks.upstashPipeline.mockResolvedValueOnce(replies(["0", [key]]));
  mocks.upstashPipeline.mockResolvedValueOnce(replies(fields));
}

/** Every command issued across every pipeline call, flattened. */
function allCommands(): (string | number)[][] {
  return mocks.upstashPipeline.mock.calls.flatMap((c) => c[0]);
}

/** `resetUserProgress` evaluates `RESET_MODULE_SOLVES_SCRIPT` once, for
 *  classic, before it touches quiz/hints. Queues that result. The tuple is
 *  `[solvesRemoved, attemptsRemoved, pointsRemoved, solvedRemoved, decremented]`
 *  — the shape the script returns. */
function mockModuleResets(classic: [number, number, number, number, number]) {
  mocks.upstashEval.mockResolvedValueOnce(classic);
}

/** The plain quiz+hints pipeline `resetUserProgress` issues after the
 *  module script: 2 DEL + 2 HDEL for quiz, 2 DEL + 1 HDEL for hints, then
 *  the HDEL of quiz's award time (#522). */
function mockQuizAndHintsPipeline() {
  mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1, 1, 1, 1, 1, 1, 1));
}

beforeEach(() => {
  vi.clearAllMocks();
  linkDeps.getGithubLink.mockResolvedValue(null);
  linkDeps.releaseGithubLink.mockResolvedValue(null);
  grantDeps.isAdminGrantee.mockResolvedValue(false);
  // The auth row exists until deleteUser removes it.
  let authRow = true;
  authDeps.findUserById.mockReset().mockImplementation(async (id: string) => (authRow ? { id } : null));
  authDeps.deleteUserSessions.mockReset().mockResolvedValue(undefined);
  authDeps.deleteAccounts.mockReset().mockResolvedValue(undefined);
  authDeps.deleteUser.mockReset().mockImplementation(async () => {
    authRow = false;
  });
  playerDeps.getPlayerProfiles.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, profile(id, "octocat")])));
});

describe("resetUserProgress brackets its writes as score-lowering (#553)", () => {
  it("opens the bracket before the first destructive write and closes it after the last", async () => {
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    await resetUserProgress("0c7aca70-0000-4000-8000-00000000000a", ADMIN);
    expect(foldCache.beginScoreLowering).toHaveBeenCalledTimes(1);
    expect(foldCache.endScoreLowering).toHaveBeenCalledTimes(1);
    const writes = [...mocks.upstashPipeline.mock.invocationCallOrder, ...mocks.upstashEval.mock.invocationCallOrder];
    expect(foldCache.beginScoreLowering.mock.invocationCallOrder[0]).toBeLessThan(Math.min(...writes));
    expect(foldCache.endScoreLowering.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...writes));
  });

  it("still closes the bracket when a later stage fails — the earlier destructive stages stand", async () => {
    // The secure-dev sweep ran; the classic module reset then throws. Those
    // solves are gone, so the bracket closes before the error propagates.
    mockNoSecureDevKeys();
    mocks.upstashEval.mockRejectedValueOnce(new Error("eval down"));
    await expect(resetUserProgress("0c7aca70-0000-4000-8000-00000000000a", ADMIN)).rejects.toThrow("eval down");
    expect(foldCache.endScoreLowering).toHaveBeenCalledTimes(1);
  });

  it("ABORTS before any write when the bracket cannot be opened — fail closed", async () => {
    foldCache.beginScoreLowering.mockRejectedValueOnce(new Error("upstash down"));
    await expect(resetUserProgress("0c7aca70-0000-4000-8000-00000000000a", ADMIN)).rejects.toThrow("upstash down");
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
    expect(mocks.upstashEval).not.toHaveBeenCalled();
    expect(foldCache.endScoreLowering).not.toHaveBeenCalled();
  });
});

describe("input validation", () => {
  it("requirePlayerId accepts a player id and refuses a GitHub login, without lowercasing", () => {
    expect(requirePlayerId(OCTO)).toBe(OCTO);
    expect(() => requirePlayerId("OctoCat")).toThrow("invalid player id");
    expect(() => requirePlayerId("octocat")).toThrow(OpsValidationError);
    expect(() => requirePlayerId(OCTO.toUpperCase())).toThrow("invalid player id");
    expect(() => requirePlayerId(`${OCTO}:x`)).toThrow("invalid player id");
    expect(() => requirePlayerId(42)).toThrow("invalid player id");
  });

  it("refuses a GitHub login on every per-player operation before any key is built", async () => {
    await expect(lookupUser("OctoCat")).rejects.toBeInstanceOf(OpsValidationError);
    await expect(resetUserProgress("OctoCat", ADMIN)).rejects.toThrow("invalid player id");
    await expect(deleteUser("OctoCat", ADMIN)).rejects.toThrow("invalid player id");
    await expect(forceAddToTeam("red-team", "OctoCat", ADMIN)).rejects.toThrow("invalid player id");
    await expect(forceRemoveFromTeam("red-team", "OctoCat", ADMIN)).rejects.toThrow("invalid player id");
    await expect(forceTransferCaptain("red-team", "OctoCat", ADMIN)).rejects.toThrow("invalid player id");
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
    expect(mocks.upstashEval).not.toHaveBeenCalled();
    expect(foldCache.beginScoreLowering).not.toHaveBeenCalled();
  });

  it("refuses a slug carrying a glob, before it can reach a key", async () => {
    // These keys are built by interpolation. An unvalidated slug is how a `*`
    // reaches a pattern or a `:` invents a key namespace.
    await expect(forceDisbandTeam("*", ADMIN)).rejects.toBeInstanceOf(OpsValidationError);
    await expect(forceDisbandTeam("a:b", ADMIN)).rejects.toBeInstanceOf(OpsValidationError);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("lookupUser", () => {
  it("reports a contestant with no team and no data as unknown", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    const detail = await lookupUser("0c7aca70-0000-4000-8000-00000000000a");
    expect(detail.known).toBe(false);
    expect(detail.team).toBeNull();
  });

  it("counts only the target's fields in a shared secure-dev solves hash", async () => {
    // `ctf:solves:<target>` holds EVERY contestant's solves for that target,
    // keyed `<login>:<challengeId>`. Counting the whole hash would report
    // another team's work as this contestant's.
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockSecureDevKeys("ctf:solves:dvwa", ["0c7aca70-0000-4000-8000-00000000000a:c1", "0c7aca70-0000-4000-8000-00000000000a:c2", "3a110000-0000-4000-8000-00000000000b:c1"]);
    const detail = await lookupUser("0c7aca70-0000-4000-8000-00000000000a");
    expect(detail.secureDev.solves).toBe(2);
    expect(detail.known).toBe(true);
  });

  it("counts a field only on the exact `<playerId>:` prefix", async () => {
    // A player id holds no ":" (PLAYER_ID_RE), so `${id}:` cannot match a
    // longer id, and a field keyed by the login is someone else's row.
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockSecureDevKeys("ctf:solves:dvwa", [`${OCTO}:c1`, `${OCTO}0:c2`, "octocat:c3", `${OCTO.toUpperCase()}:c4`]);
    expect((await lookupUser(OCTO)).secureDev.solves).toBe(1);
  });

  it("names the player from their profile, and falls back when they have none", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    const detail = await lookupUser(OCTO);
    expect(detail.id).toBe(OCTO);
    expect(detail.name).toBe("octocat");
    expect(playerDeps.getPlayerProfiles).toHaveBeenCalledWith([OCTO]);
    expect(detail).not.toHaveProperty("login");

    playerDeps.getPlayerProfiles.mockResolvedValueOnce(new Map());
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    expect((await lookupUser(OCTO)).name).toBe("player 0c7aca70");
  });

  it("sums attempts out of the JSON rows, not by coercing them to numbers", async () => {
    // The attempts hash stores a JSON OBJECT per item, not a count. Summing it
    // with `Number(value)` yields NaN — which, coerced through `|| 0`, made the
    // support tab report "Attempts 0" for every contestant on every event, and
    // report it confidently. Nothing caught it: while the demo seed wrote no
    // attempt rows at all, zero WAS the right answer for seeded data, so the
    // bug and the fixture agreed with each other.
    //
    // Upstash returns HGETALL as a flat [field, value, field, value] array.
    const quizAttempts = [
      "xss-basics",
      JSON.stringify({ attempts: 2, firstAt: "2026-08-22T10:00:00Z", lastAt: "2026-08-22T10:06:00Z" }),
      "csrf-defense",
      JSON.stringify({ attempts: 3, firstAt: "2026-08-22T11:00:00Z", lastAt: "2026-08-22T11:09:00Z" }),
    ];
    const classicAttempts = [
      "web-robots-only",
      JSON.stringify({ attempts: 4, firstAt: "2026-08-22T12:00:00Z", lastAt: "2026-08-22T12:20:00Z" }),
    ];
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], quizAttempts, null, null, [], classicAttempts, null, null, 0, null),
    );
    mockNoSecureDevKeys();
    const detail = await lookupUser("0c7aca70-0000-4000-8000-00000000000a");
    expect(detail.quiz.attempts).toBe(5);
    expect(detail.classic.attempts).toBe(4);
  });

  it("treats an unreadable attempt row as no attempts rather than throwing", async () => {
    // A support lookup runs mid-event, on live data, when something has
    // already gone wrong. One corrupt row must not take the whole lookup down.
    const rows = ["good", JSON.stringify({ attempts: 2 }), "corrupt", "{not json", "empty", ""];
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], rows, null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    expect((await lookupUser("0c7aca70-0000-4000-8000-00000000000a")).quiz.attempts).toBe(2);
  });

  it("marks the captain of their team", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget("red-team", "2026-08-22T10:00:00Z", "2026-08-20T09:00:00Z"), [], [], "10", "1", [], [], null, null, 0, null),
    );
    mocks.upstashPipeline.mockResolvedValueOnce(replies("Red Team", OCTO));
    mockNoSecureDevKeys();
    const detail = await lookupUser(OCTO);
    expect(detail.team).toEqual({
      slug: "red-team",
      name: "Red Team",
      captain: OCTO,
      isCaptain: true,
      joinedAt: "2026-08-22T10:00:00Z",
    });
    // The funnel's conversion moment, and it is EARLIER than joinedAt here —
    // this contestant switched teams, and firstTeamAt is what must not move.
    expect(detail.firstTeamAt).toBe("2026-08-20T09:00:00Z");
  });
});

// Issue #358. The SCAN walk is only half of it: this function reports how much
// of a contestant's progress it removed, and that number came from the FIELDS
// it intended to delete rather than from the delete's own reply. A failed HDEL
// therefore told the organizer a contestant was cleared while their solves
// were still there to be scored.
describe("resetUserProgress: a failed secure-dev delete is not a clear", () => {
  it("rejects when the HDEL fails, rather than counting those fields as removed", async () => {
    mocks.upstashPipeline
      .mockResolvedValueOnce(replies(["0", ["ctf:solves:juice-shop"]])) // SCAN page
      .mockResolvedValueOnce(replies(["0c7aca70-0000-4000-8000-00000000000a:sqli-1"])) // HKEYS
      .mockResolvedValueOnce([{ error: "READONLY You can't write against a read only replica." }]); // HDEL

    await expect(resetUserProgress("0c7aca70-0000-4000-8000-00000000000a", ADMIN)).rejects.toThrow(
      /command failed \(clear secure-dev solves\)/,
    );
  });

  it("rejects when the HKEYS fails, rather than reading it as 'nothing here'", async () => {
    mocks.upstashPipeline
      .mockResolvedValueOnce(replies(["0", ["ctf:solves:juice-shop"]])) // SCAN page
      .mockResolvedValueOnce([{ error: "WRONGTYPE Operation against a key holding the wrong kind of value" }]);

    await expect(resetUserProgress("0c7aca70-0000-4000-8000-00000000000a", ADMIN)).rejects.toThrow(
      /command failed \(clear secure-dev solves\)/,
    );
  });
});

describe("resetUserProgress", () => {
  it("DECREMENTS the classic per-challenge solve counter instead of deleting by login", async () => {
    // ctf:classic:solvecount is HINCRBY'd by CHALLENGE ID, not by login —
    // unlike every other aggregate here. HDELing it by login would remove
    // nothing and leave each challenge still counting a contestant whose
    // solves are gone, so the per-challenge stats would drift up permanently,
    // once per reset. The count comes back through the script's own return
    // value now, not a JS-side HKEYS.
    mockNoSecureDevKeys();
    mockModuleResets([1, 1, 1, 1, 2]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // audit

    const result = await resetUserProgress("0c7aca70-0000-4000-8000-00000000000a", ADMIN);

    expect(result.cleared.classicSolveCountsDecremented).toBe(2);
    const [script, keys, argv] = mocks.upstashEval.mock.calls[0];
    expect(script).toMatch(/HINCRBY/);
    expect(keys).toEqual([
      "ctf:classic:solves:0c7aca70-0000-4000-8000-00000000000a",
      "ctf:classic:attempts:0c7aca70-0000-4000-8000-00000000000a",
      "ctf:classic:points",
      "ctf:classic:solved",
      "ctf:classic:solvecount",
      "ctf:classic:lastAt",
    ]);
    // Login only — never a solved id, and never a raw HDEL/DEL of the
    // solvecount key from JS. The script is the only thing that ever
    // touches it.
    expect(argv).toEqual(["0c7aca70-0000-4000-8000-00000000000a"]);
  });

  it("decides its decrements from the script's OWN runtime read, never a pre-read snapshot (regression)", async () => {
    // CodeRabbit round-2: reading solved ids in one request, then deleting
    // rows and decrementing solvecount by that SNAPSHOT in a later request,
    // leaves a window — a solve landing in between gets DELeted with no
    // matching decrement, and solvecount drifts up forever. The fix is that
    // resetModuleSolves no longer reads anything in JS at all: it hands the
    // script only the login, and the script's own HKEYS (at execution time,
    // inside the same atomic EVAL as the decrements) is what decides how
    // many challenges to decrement. Pin that shape directly: ARGV is ALWAYS
    // exactly [login] — a solved id must never appear in an
    // EVAL call, pre-read or otherwise, because there is no such read left
    // to produce one.
    mockNoSecureDevKeys();
    mockModuleResets([1, 1, 1, 1, 5]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // audit

    const result = await resetUserProgress("0c7aca70-0000-4000-8000-00000000000a", ADMIN);

    // These numbers can only have come from the mocked script's return value
    // — there is no JS-side count for them to have come from instead.
    expect(result.cleared.classicSolveCountsDecremented).toBe(5);

    expect(mocks.upstashEval).toHaveBeenCalledTimes(1);
    for (const [, , argv] of mocks.upstashEval.mock.calls) {
      expect(argv).toEqual(["0c7aca70-0000-4000-8000-00000000000a"]);
    }
  });

  it("clears every per-login key and nobody else's", async () => {
    mockNoSecureDevKeys();
    mockModuleResets([1, 1, 1, 1, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));

    await resetUserProgress("0c7aca70-0000-4000-8000-00000000000a", ADMIN);

    const touched = allCommands()
      .filter((c) => c[0] === "DEL" || c[0] === "HDEL")
      .map((c) => String(c[1]) + (c[0] === "HDEL" ? `#${c[2]}` : ""));
    expect(touched).toEqual([
      "ctf:quiz:answers:0c7aca70-0000-4000-8000-00000000000a",
      "ctf:quiz:attempts:0c7aca70-0000-4000-8000-00000000000a",
      "ctf:quiz:points#0c7aca70-0000-4000-8000-00000000000a",
      "ctf:quiz:answered#0c7aca70-0000-4000-8000-00000000000a",
      "ctf:user:0c7aca70-0000-4000-8000-00000000000a:hints",
      "ctf:hints:at:0c7aca70-0000-4000-8000-00000000000a",
      "ctf:hints:spent#0c7aca70-0000-4000-8000-00000000000a",
      // #522: the award time goes with the totals it orders.
      "ctf:quiz:lastAt#0c7aca70-0000-4000-8000-00000000000a",
      // #616: the first-open times, which only time this login's solves.
      "ctf:classic:opened:0c7aca70-0000-4000-8000-00000000000a",
    ]);
    // Classic's per-login keys are cleared through the atomic
    // script instead — assert those calls named exactly this login's keys.
    const evalKeys = mocks.upstashEval.mock.calls.map((c) => c[1]);
    expect(evalKeys).toEqual([
      [
        "ctf:classic:solves:0c7aca70-0000-4000-8000-00000000000a",
        "ctf:classic:attempts:0c7aca70-0000-4000-8000-00000000000a",
        "ctf:classic:points",
        "ctf:classic:solved",
        "ctf:classic:solvecount",
        "ctf:classic:lastAt",
      ],
    ]);
  });

  it("leaves the account and team membership alone", async () => {
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));

    await resetUserProgress("0c7aca70-0000-4000-8000-00000000000a", ADMIN);

    const cmds = allCommands();
    expect(cmds).not.toContainEqual(["DEL", "ctf:user:0c7aca70-0000-4000-8000-00000000000a"]);
    expect(cmds.some((c) => c[0] === "SREM")).toBe(false);
  });

  it("WARNS that secure-dev solves come back, rather than pretending", async () => {
    // The scorer writes them with HSETNX so replays no-op, and the poller
    // re-submits from PR comments — so these return on the next re-score.
    // Silence here would be a lie the organizer only discovers later.
    mockSecureDevKeys("ctf:solves:dvwa", ["0c7aca70-0000-4000-8000-00000000000a:c1"]);
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1)); // HDEL of those fields
    mockModuleResets([0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));

    const result = await resetUserProgress("0c7aca70-0000-4000-8000-00000000000a", ADMIN);
    expect(result.cleared.secureDevSolves).toBe(1);
    expect(result.warnings.join(" ")).toMatch(/HSETNX|re-ingest/i);
  });

  it("says nothing about secure-dev when there was none to clear", async () => {
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));
    expect((await resetUserProgress("0c7aca70-0000-4000-8000-00000000000a", ADMIN)).warnings).toEqual([]);
  });

  it("writes an audit line naming the actor AND the target", async () => {
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));

    await resetUserProgress("0c7aca70-0000-4000-8000-00000000000a", ALICE_ACTOR);

    const push = allCommands().find((c) => c[0] === "LPUSH" && c[1] === "ctf:admin:audit");
    const line = JSON.parse(String(push?.[2])) as Record<string, unknown>;
    expect(line.by).toBe(ALICE_ACTOR.id);
    expect(line.name).toBe("alice");
    expect(line.player).toBe(OCTO);
    expect(line).not.toHaveProperty("login");
    expect(line.action).toBe("ops:user-reset");
  });
});

// upstashPipeline reports a per-command failure in `error` and never throws
// for it. Read past, a WRONGTYPE becomes a missing `.result`, which these
// stores read as zero: a card of empty figures, or a reset that claims to
// have cleared progress still stored.
describe("a per-command pipeline error is a failure, not zero", () => {
  const WRONGTYPE = "WRONGTYPE Operation against a key holding the wrong kind of value";

  it("lookupUser rejects when a read in its main pipeline fails", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      ...replies(userHmget(null), [], []),
      { error: WRONGTYPE },
      ...replies(null, [], [], null, null, 0, null),
    ]);
    await expect(lookupUser(OCTO)).rejects.toThrow(/command failed \(lookup user\)/);
  });

  it("lookupUser rejects when its team read fails", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget("red-team", "2026-08-22T10:00:00Z"), [], [], null, null, [], [], null, null, 0, null),
    );
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "Red Team" }, { error: WRONGTYPE }]);
    await expect(lookupUser(OCTO)).rejects.toThrow(/command failed \(lookup user team\)/);
  });

  it("resetUserProgress rejects when a quiz or hint cleanup fails, and audits no success", async () => {
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0]);
    mocks.upstashPipeline.mockResolvedValueOnce([
      ...replies(1, 1, 1),
      { error: WRONGTYPE },
      ...replies(1, 1, 1, 1, 1, 1),
    ]);

    await expect(resetUserProgress(OCTO, ADMIN)).rejects.toThrow(/command failed \(reset progress\)/);
    expect(allCommands().some((c) => c[0] === "LPUSH" && c[1] === "ctf:admin:audit")).toBe(false);
  });
});

describe("deleteUser", () => {
  it("refuses to delete a captain, naming the way out", async () => {
    // Deleting the captain would leave a team nobody can administer: rename,
    // remove, regenerate and disband are all captain-only.
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget("red-team"), [], [], null, null, [], [], null, null, 0, null),
    );
    mocks.upstashPipeline.mockResolvedValueOnce(replies("Red Team", "0c7aca70-0000-4000-8000-00000000000a"));
    mockNoSecureDevKeys();

    await expect(deleteUser("0c7aca70-0000-4000-8000-00000000000a", ADMIN)).rejects.toThrow(/captain/i);
    // and nothing was cleared on the way to that refusal
    expect(allCommands().some((c) => c[0] === "DEL")).toBe(false);
  });

  it("removes the membership and the account record", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget("red-team"), [], [], null, null, [], [], null, null, 0, null),
    );
    mocks.upstashPipeline.mockResolvedValueOnce(replies("Red Team", "a11ce000-0000-4000-8000-00000000000c"));
    mockNoSecureDevKeys();
    mockNoSecureDevKeys(); // the reset's own sweep
    mockModuleResets([0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // reset audit
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // SREM + DEL
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // delete audit

    const result = await deleteUser("0c7aca70-0000-4000-8000-00000000000a", ADMIN);
    expect(result.leftTeam).toBe("red-team");
    const cmds = allCommands();
    expect(cmds).toContainEqual(["SREM", "ctf:team:red-team:members", "0c7aca70-0000-4000-8000-00000000000a"]);
    expect(cmds).toContainEqual(["DEL", "ctf:user:0c7aca70-0000-4000-8000-00000000000a"]);
    // Every rate-limit bucket's counter for this player goes with them.
    for (const bucket of ["team-join", "hint-reveal"]) {
      expect(cmds).toContainEqual(["DEL", `ctf:rl:${bucket}:${OCTO}`]);
    }
    // The account goes through better-auth's adapter and the link through
    // github-link's script: no pipeline here names a ctf:auth:* or ctf:link:* key.
    expect(cmds.some((c) => c.slice(1).some((a) => /^ctf:(auth|link):/.test(String(a))))).toBe(false);
    // #553: the delete brackets the WHOLE thing (the inner reset nests its
    // own bracket — the marker is a counter), so the in-progress flag stays
    // up through the tail writes (membership, account record) and the last
    // close comes after the last write.
    expect(foldCache.beginScoreLowering).toHaveBeenCalledTimes(2);
    expect(foldCache.endScoreLowering).toHaveBeenCalledTimes(2);
    // The lookup before the reset is a READ; the bound is the first WRITE
    // (the tail's SREM certainly is one).
    const srem = mocks.upstashPipeline.mock.calls.findIndex((c) => c[0].some((cmd) => cmd[0] === "SREM"));
    expect(srem).toBeGreaterThan(-1);
    expect(foldCache.beginScoreLowering.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.upstashPipeline.mock.invocationCallOrder[srem],
    );
    expect(Math.max(...foldCache.endScoreLowering.mock.invocationCallOrder)).toBeGreaterThan(
      Math.max(...mocks.upstashPipeline.mock.invocationCallOrder),
    );
  });
});

describe("deleteUser: held Secure Development scores", () => {
  /** Queues the pipelines a no-team, no-SD-keys delete walks through. */
  function queueDelete() {
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // reset audit
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // tail
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // delete audit
  }

  it("clears the linked login's held scores by one script after the record is gone, link untouched", async () => {
    linkDeps.getGithubLink.mockResolvedValueOnce({ login: "octocat", linkedAt: 1 });
    queueDelete();
    mocks.upstashEval.mockResolvedValueOnce(1);
    await deleteUser(OCTO, ADMIN);
    const calls = mocks.upstashPipeline.mock.calls.map((c) => c[0]);
    const tailAt = calls.findIndex((cmds) => cmds.some((c) => c[0] === "DEL" && c[1] === `ctf:user:${OCTO}`));
    expect(calls[tailAt].some((c) => String(c[1]).startsWith("ctf:sd:held"))).toBe(false);
    // One script, the hash before the author index, after the record's DEL.
    expect(mocks.upstashEval).toHaveBeenCalledWith(CLEAR_HELD_SCRIPT, ["ctf:sd:held:by:octocat", "ctf:sd:held:authors"], ["octocat"]);
    expect(CLEAR_HELD_SCRIPT.indexOf("DEL")).toBeLessThan(CLEAR_HELD_SCRIPT.indexOf("SREM"));
    const clearAt = mocks.upstashEval.mock.calls.findIndex((c) => c[0] === CLEAR_HELD_SCRIPT);
    expect(mocks.upstashEval.mock.invocationCallOrder[clearAt]).toBeGreaterThan(
      mocks.upstashPipeline.mock.invocationCallOrder[tailAt],
    );
    expect(allCommands().some((c) => c.slice(1).some((a) => /^ctf:link:/.test(String(a))))).toBe(false);
  });

  it("clears nothing held for an unlinked player", async () => {
    linkDeps.getGithubLink.mockResolvedValueOnce(null);
    queueDelete();
    await deleteUser(OCTO, ADMIN);
    expect(allCommands().some((c) => c.slice(1).some((a) => String(a).startsWith("ctf:sd:held")))).toBe(false);
  });

  it("aborts before any write when the link read fails", async () => {
    linkDeps.getGithubLink.mockRejectedValueOnce(new Error("github link: GET failed: READONLY"));
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/github link/);
    expect(foldCache.beginScoreLowering).not.toHaveBeenCalled();
    expect(allCommands().some((c) => c[0] === "DEL")).toBe(false);
  });
});

describe("deleteUser: held scores outlive a failed record delete", () => {
  it("leaves the held scores when the record's DEL fails, so a player who stays keeps them", async () => {
    linkDeps.getGithubLink.mockResolvedValueOnce({ login: "octocat", linkedAt: 1 });
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // reset audit
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "READONLY" }]); // tail
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/READONLY/);
    expect(mocks.upstashEval.mock.calls.some((c) => c[0] === CLEAR_HELD_SCRIPT)).toBe(false);
    expect(allCommands().some((c) => String(c[1]).startsWith("ctf:sd:held"))).toBe(false);
  });
});

describe("deleteUser: a failed tail write is not a delete", () => {
  it("rejects when the membership/account pipeline reports an error", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // reset audit
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "READONLY" }]);
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/READONLY/);
    expect(foldCache.endScoreLowering).toHaveBeenCalledTimes(2);
  });
});

describe("deleteUser: the account and its GitHub login", () => {
  /** Queues the pipelines a no-team, no-SD-keys delete walks through; a
   *  delete that fails before its audit line queues none for it, so no reply
   *  is left over for the next test. */
  function queueDelete(audited = true) {
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // reset audit
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // tail
    if (audited) mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // delete audit
  }
  const auditLine = (action: string) => {
    const cmd = allCommands().find((c) => c[0] === "LPUSH" && String(c[2]).includes(`"${action}"`));
    return cmd ? JSON.parse(String(cmd[2])) : null;
  };
  const nothingDeleted = () => {
    expect(allCommands().some((c) => c[0] === "DEL" || c[0] === "SREM" || c[0] === "LPUSH")).toBe(false);
    expect(mocks.upstashEval).not.toHaveBeenCalled();
    expect(linkDeps.releaseGithubLink).not.toHaveBeenCalled();
    expect(authDeps.deleteUserSessions).not.toHaveBeenCalled();
    expect(authDeps.deleteAccounts).not.toHaveBeenCalled();
    expect(authDeps.deleteUser).not.toHaveBeenCalled();
  };

  it("refuses an organizer with the organizer copy and deletes nothing", async () => {
    grantDeps.isAdminGrantee.mockResolvedValue(true);
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    const err = await deleteUser(OCTO, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(OpsValidationError);
    expect(err.message).toBe("octocat is an organizer. Revoke their admin access first.");
    expect(grantDeps.isAdminGrantee).toHaveBeenCalledWith(OCTO);
    nothingDeleted();
    expect(foldCache.beginScoreLowering).not.toHaveBeenCalled();
  });

  it("checks the grant before the captaincy", async () => {
    grantDeps.isAdminGrantee.mockResolvedValue(true);
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget("red-team"), [], [], null, null, [], [], null, null, 0, null),
    );
    mocks.upstashPipeline.mockResolvedValueOnce(replies("Red Team", OCTO));
    mockNoSecureDevKeys();
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/organizer/);
    nothingDeleted();
  });

  it("a failed grant read refuses instead of reading as not an organizer", async () => {
    grantDeps.isAdminGrantee.mockRejectedValue(new Error("Upstash SISMEMBER admin grants failed: NOAUTH"));
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/NOAUTH/);
    nothingDeleted();
  });

  it("releases the link with a block before any progress write, then deletes sessions, accounts and the user, then audits", async () => {
    linkDeps.getGithubLink.mockResolvedValueOnce({ login: "octocat", linkedAt: 1 });
    linkDeps.releaseGithubLink.mockResolvedValueOnce("octocat");
    queueDelete();
    mocks.upstashEval.mockResolvedValueOnce(1); // held clear
    await deleteUser(OCTO, ADMIN);

    expect(linkDeps.releaseGithubLink).toHaveBeenCalledWith(OCTO, { block: true });
    expect(authDeps.deleteUserSessions).toHaveBeenCalledWith(OCTO);
    expect(authDeps.deleteAccounts).toHaveBeenCalledWith(OCTO);
    expect(authDeps.deleteUser).toHaveBeenCalledWith(OCTO);
    const order = [
      linkDeps.releaseGithubLink.mock.invocationCallOrder[0],
      mocks.upstashEval.mock.invocationCallOrder[0], // first progress write (the classic reset)
      mocks.upstashEval.mock.invocationCallOrder.at(-1)!, // held clear
      authDeps.deleteUserSessions.mock.invocationCallOrder[0],
      authDeps.deleteAccounts.mock.invocationCallOrder[0],
      authDeps.deleteUser.mock.invocationCallOrder[0],
      mocks.upstashPipeline.mock.invocationCallOrder.at(-1)!, // audit
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(auditLine("ops:user-delete")).toMatchObject({
      action: "ops:user-delete",
      player: OCTO,
      leftTeam: null,
      blockedLogin: "octocat",
      by: ADMIN.id,
    });
  });

  it("audits blockedLogin null for a player with no link", async () => {
    queueDelete();
    await deleteUser(OCTO, ADMIN);
    expect(linkDeps.releaseGithubLink).toHaveBeenCalledWith(OCTO, { block: true });
    expect(auditLine("ops:user-delete")).toMatchObject({ player: OCTO, blockedLogin: null });
  });

  it("deletes an account that holds no event state", async () => {
    queueDelete();
    await expect(deleteUser(OCTO, ADMIN)).resolves.toMatchObject({ leftTeam: null });
    expect(authDeps.deleteUser).toHaveBeenCalledWith(OCTO);
  });

  it("an id with neither an account nor event state is No such player., and nothing is written", async () => {
    authDeps.findUserById.mockResolvedValue(null);
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    const err = await deleteUser(OCTO, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(OpsValidationError);
    expect(err.message).toBe("No such player.");
    nothingDeleted();
  });

  it("event state with no account row is still deleted", async () => {
    authDeps.findUserById.mockResolvedValue(null);
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget("red-team"), [], [], null, null, [], [], null, null, 0, null),
    );
    mocks.upstashPipeline.mockResolvedValueOnce(replies("Red Team", BOB));
    mockNoSecureDevKeys();
    mockNoSecureDevKeys();
    mockModuleResets([0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // reset audit
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // tail
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // audit
    await expect(deleteUser(OCTO, ADMIN)).resolves.toMatchObject({ leftTeam: "red-team" });
  });

  it("a failed auth delete rejects with no audit line", async () => {
    linkDeps.releaseGithubLink.mockResolvedValueOnce("octocat");
    queueDelete(false);
    authDeps.deleteAccounts.mockRejectedValueOnce(new Error("auth store: deleteMany account failed"));
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow("auth store");
    expect(authDeps.deleteUser).not.toHaveBeenCalled();
    expect(auditLine("ops:user-delete")).toBeNull();
    expect(foldCache.endScoreLowering).toHaveBeenCalledTimes(2);
  });

  it("a user row that survives the delete is a failure, not a delete", async () => {
    // better-auth's single-row delete swallows a failed read and deletes
    // nothing; the re-read is what notices.
    authDeps.deleteUser.mockResolvedValueOnce(undefined);
    queueDelete(false);
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/account/);
    expect(auditLine("ops:user-delete")).toBeNull();
  });
});

describe("deleteAllAccounts", () => {
  const auditLine = () => {
    const cmd = allCommands().find((c) => c[0] === "LPUSH");
    return cmd ? JSON.parse(String(cmd[2])) : null;
  };

  it.each([["DELETE ALL ACCOUNTS"], ["delete all accounts "], [""], [undefined], [true]])(
    "refuses confirm %j and changes nothing",
    async (confirm) => {
      const err = await deleteAllAccounts(confirm, ADMIN).catch((e) => e);
      expect(err).toBeInstanceOf(OpsValidationError);
      expect(err.field).toBe("confirm");
      expect(err.message).toBe("Type delete all accounts to confirm.");
      expect(storeDeps.resetEvent).not.toHaveBeenCalled();
      expect(storeDeps.scanDelByPrefix).not.toHaveBeenCalled();
      expect(mocks.upstashPipeline).not.toHaveBeenCalled();
    },
  );

  it("resets the event, sweeps the account namespaces, drops the grants, and audits the counts", async () => {
    storeDeps.resetEvent.mockResolvedValueOnce({ cleared: { solves: 3, users: 2 }, resetAt: "1" });
    storeDeps.scanDelByPrefix.mockImplementation(async (pattern: string) => pattern.length);
    mocks.upstashPipeline.mockResolvedValueOnce(replies(2)); // DEL grants + gen
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // audit

    const { cleared } = await deleteAllAccounts("delete all accounts", ADMIN);

    expect(storeDeps.resetEvent).toHaveBeenCalledWith(ADMIN);
    // The links go first, so sync holds a linked login's scores instead of
    // scoring them into the reset; master reset clears ctf:relink:* itself.
    expect(storeDeps.scanDelByPrefix.mock.calls.map((c) => c[0])).toEqual([
      "ctf:link:*",
      "ctf:auth:*",
      "ctf:admin:code:*",
      "ctf:admin:reset-code:*",
    ]);
    expect(storeDeps.scanDelByPrefix.mock.invocationCallOrder[0]).toBeLessThan(
      storeDeps.resetEvent.mock.invocationCallOrder[0],
    );
    expect(storeDeps.resetEvent.mock.invocationCallOrder[0]).toBeLessThan(
      storeDeps.scanDelByPrefix.mock.invocationCallOrder[1],
    );
    expect(allCommands()).toContainEqual(["DEL", "ctf:admin:grants", "ctf:admin:grant-gen"]);
    // The spent bootstrap code stays spent.
    expect(allCommands().some((c) => c.includes("ctf:admin:claim:spent"))).toBe(false);
    expect(storeDeps.scanDelByPrefix.mock.calls.some((c) => "ctf:admin:claim:spent".startsWith(String(c[0]).replace("*", "")))).toBe(false);
    expect(cleared).toEqual({
      solves: 3,
      users: 2,
      auth: "ctf:auth:*".length,
      links: "ctf:link:*".length,
      adminCodes: "ctf:admin:code:*".length,
      resetCodes: "ctf:admin:reset-code:*".length,
      adminGrantKeys: 2,
    });
    expect(auditLine()).toMatchObject({ action: "ops:delete-all-accounts", by: ADMIN.id, cleared });
  });

  it("a failed sweep rejects with no audit line and no grant delete", async () => {
    storeDeps.resetEvent.mockResolvedValueOnce({ cleared: {}, resetAt: "1" });
    storeDeps.scanDelByPrefix.mockResolvedValueOnce(0).mockRejectedValueOnce(new Error("command failed (reset ctf:auth:*): READONLY"));
    await expect(deleteAllAccounts("delete all accounts", ADMIN)).rejects.toThrow(/READONLY/);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("a failed grant delete rejects with no audit line", async () => {
    storeDeps.resetEvent.mockResolvedValueOnce({ cleared: {}, resetAt: "1" });
    storeDeps.scanDelByPrefix.mockResolvedValue(0);
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "READONLY" }]);
    await expect(deleteAllAccounts("delete all accounts", ADMIN)).rejects.toThrow(/READONLY/);
    expect(auditLine()).toBeNull();
  });

  it("a failed reset stops after the links, before any account is touched", async () => {
    storeDeps.resetEvent.mockRejectedValueOnce(new Error("reset failed"));
    storeDeps.scanDelByPrefix.mockResolvedValue(0);
    await expect(deleteAllAccounts("delete all accounts", ADMIN)).rejects.toThrow("reset failed");
    expect(storeDeps.scanDelByPrefix.mock.calls.map((c) => c[0])).toEqual(["ctf:link:*"]);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("team overrides", () => {
  it("refuses to remove the captain", async () => {
    mocks.upstashEval.mockResolvedValueOnce("is-captain");
    await expect(forceRemoveFromTeam("red-team", "0c7aca70-0000-4000-8000-00000000000a", ADMIN)).rejects.toThrow(/captain/i);
  });

  it("refuses to remove someone who is not on the team", async () => {
    mocks.upstashEval.mockResolvedValueOnce("not-member");
    await expect(forceRemoveFromTeam("red-team", "0c7aca70-0000-4000-8000-00000000000a", ADMIN)).rejects.toThrow(/not on/i);
  });

  it("clears the user's team pointer in the SAME script as the SREM", async () => {
    // A member set and the ctf:user:<login> hash that points at it must not be
    // able to disagree, so the two writes are one atomic step — the same rule
    // team-store's own captain actions follow.
    mocks.upstashEval.mockResolvedValueOnce("ok");
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));
    await forceRemoveFromTeam("red-team", "0c7aca70-0000-4000-8000-00000000000a", ADMIN);
    const [script] = mocks.upstashEval.mock.calls[0];
    expect(script).toContain("SREM");
    expect(script).toContain("HDEL");
  });

  it("will not hand a team to someone who is not a member", async () => {
    mocks.upstashEval.mockResolvedValueOnce("not-member");
    await expect(forceTransferCaptain("red-team", "00751de0-0000-4000-8000-00000000000e", ADMIN)).rejects.toThrow(/not on/i);
  });

  it("checks membership INSIDE the transfer script, not before it", async () => {
    mocks.upstashEval.mockResolvedValueOnce("ok");
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));
    await forceTransferCaptain("red-team", "b0b00000-0000-4000-8000-00000000000d", ADMIN);
    const [script, keys] = mocks.upstashEval.mock.calls[0];
    expect(script).toContain("SISMEMBER");
    expect(keys).toEqual(["ctf:team:red-team", "ctf:team:red-team:members"]);
  });

  it("disband releases every member and kills the join code", async () => {
    // A surviving reverse index keeps resolving to a team that no longer
    // exists, and /join/<code> would render a card for a ghost.
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, ["a11ce000-0000-4000-8000-00000000000c", "b0b00000-0000-4000-8000-00000000000d"], "ABC123"));
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1, 1, 1));
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));

    const result = await forceDisbandTeam("red-team", ADMIN);
    expect(result.members).toBe(2);
    const cmds = allCommands();
    expect(cmds).toContainEqual(["HDEL", "ctf:user:a11ce000-0000-4000-8000-00000000000c", "team", "joinedAt"]);
    expect(cmds).toContainEqual(["HDEL", "ctf:user:b0b00000-0000-4000-8000-00000000000d", "team", "joinedAt"]);
    expect(cmds).toContainEqual(["DEL", "ctf:joincode:abc123"]);
  });

  it("disband does NOT delete anyone's progress", async () => {
    // Solves are per login, so a disbanded team's players keep what they
    // earned and can regroup. Deleting their work because the team was wrong
    // would turn an admin convenience into a scoring incident.
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, ["a11ce000-0000-4000-8000-00000000000c"], "ABC123"));
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1, 1));
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));

    await forceDisbandTeam("red-team", ADMIN);
    const cmds = allCommands();
    expect(cmds.some((c) => String(c[1]).startsWith("ctf:classic:solves:"))).toBe(false);
    expect(cmds.some((c) => String(c[1]).startsWith("ctf:quiz:answers:"))).toBe(false);
  });

  it("refuses to disband a team that does not exist", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce(replies(0, [], null));
    await expect(forceDisbandTeam("ghost", ADMIN)).rejects.toThrow(/No team/);
  });
});

// CodeRabbit on #274: `known` counted solves and hints but never attempts, so
// a contestant who had tried and never solved read as "no data — check the
// spelling". Applies to every module's attempts.
describe("lookupUser — known", () => {
  it("counts a contestant with attempts but no solves as known", async () => {
    const classicAttempts = ["guardrail-bypass", JSON.stringify({ attempts: 2, firstAt: "2026-09-03T01:40:00Z", lastAt: "2026-09-03T01:41:00Z" })];
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], [], null, null, [], classicAttempts, null, null, 0, null),
    );
    mockNoSecureDevKeys();
    const detail = await lookupUser("0c7aca70-0000-4000-8000-00000000000a");
    expect(detail.classic.attempts).toBe(2);
    expect(detail.known).toBe(true);

    const quizAttempts = ["xss-basics", JSON.stringify({ attempts: 1, firstAt: "2026-09-03T01:40:00Z", lastAt: "2026-09-03T01:40:00Z" })];
    mocks.upstashPipeline.mockResolvedValueOnce(
      replies(userHmget(null), [], quizAttempts, null, null, [], [], null, null, 0, null),
    );
    mockNoSecureDevKeys();
    expect((await lookupUser("0c7aca70-0000-4000-8000-00000000000a")).known).toBe(true);
  });
});

describe("lookupUser — github", () => {
  it("carries the player's GitHub link, or null", async () => {
    const id = "0c7aca70-0000-4000-8000-00000000000a";
    mocks.upstashPipeline.mockResolvedValueOnce(replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null));
    mockNoSecureDevKeys();
    linkDeps.getGithubLink.mockResolvedValueOnce({ login: "octocat", linkedAt: 7 });
    expect((await lookupUser(id)).github).toEqual({ login: "octocat", linkedAt: 7 });

    mocks.upstashPipeline.mockResolvedValueOnce(replies(userHmget(null), [], [], null, null, [], [], null, null, 0, null));
    mockNoSecureDevKeys();
    expect((await lookupUser(id)).github).toBeNull();
  });
});

// #597: after registration closes a player who left can't rejoin on their
// own; an organizer puts them on a team (or moves them) from Support. The
// write is one atomic script, keyed by the player id the search handed over.
describe("forceAddToTeam (#597)", () => {
  it("adds the player by id, with the cap, and names them in the answer", async () => {
    mocks.upstashEval.mockResolvedValueOnce(["ok", ""]);
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));
    const result = await forceAddToTeam("Red-Team", OCTO, ADMIN);
    expect(result).toEqual({ ok: true, id: OCTO, name: "octocat", from: null });
    const [script, keys, args] = mocks.upstashEval.mock.calls[0];
    expect(script).toContain("SADD");
    expect(keys).toEqual(["ctf:team:red-team", "ctf:team:red-team:members", `ctf:user:${OCTO}`]);
    expect(args.slice(0, 3)).toEqual([OCTO, "red-team", "4"]);
    expect(teamDeps.logActivity).toHaveBeenCalledWith("team-join", { id: OCTO, name: "octocat" }, "red-team");
    const push = allCommands().find((c) => c[0] === "LPUSH");
    const line = JSON.parse(String(push?.[2])) as Record<string, unknown>;
    expect(line).toMatchObject({ by: ADMIN.id, name: "admin", action: "ops:team-add-member", player: OCTO, slug: "red-team" });
  });

  // The script has already moved the player when the audit line is written,
  // so a failed audit write is logged and the add still reports success: a
  // 503 would send the organizer to retry a move that already happened.
  it("still succeeds, and logs the join, when the audit write fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upstashEval.mockResolvedValueOnce(["ok", "blue"]);
    mocks.upstashPipeline.mockRejectedValueOnce(new Error("upstash down"));
    const result = await forceAddToTeam("red-team", BOB, ADMIN);
    expect(result).toEqual({ ok: true, id: BOB, name: "octocat", from: "blue" });
    expect(teamDeps.logActivity).toHaveBeenCalledWith("team-join", { id: BOB, name: "octocat" }, "red-team");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("ops:team-add-member"), expect.anything());
    spy.mockRestore();
  });

  // A per-command error resolves rather than throws, so it must be read off
  // the reply to be logged at all.
  it("logs an audit write refused per command, and still succeeds", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upstashEval.mockResolvedValueOnce(["ok", ""]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "WRONGTYPE Operation against a key holding the wrong kind of value" }, { result: "OK" }]);
    expect(await forceAddToTeam("red-team", BOB, ADMIN)).toMatchObject({ ok: true, id: BOB, from: null });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("ops:team-add-member"), expect.stringContaining("WRONGTYPE"));
    spy.mockRestore();
  });

  it("refuses an id with no account, writing nothing", async () => {
    playerDeps.getPlayerProfiles.mockResolvedValueOnce(new Map());
    await expect(forceAddToTeam("red-team", BOB, ADMIN)).rejects.toThrow(/no player/i);
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("hands the script no cap when the admin overrides it", async () => {
    mocks.upstashEval.mockResolvedValueOnce(["ok", "blue"]);
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));
    expect(await forceAddToTeam("red-team", BOB, ADMIN, { overrideCap: true })).toMatchObject({ ok: true, id: BOB, from: "blue" });
    expect(mocks.upstashEval.mock.calls[0][2][2]).toBe("");
  });

  it.each([
    [["no-team"], /No team "red-team"/],
    [["already-member"], /already on "red-team"/],
    [["full"], /full \(4 players\).*override/],
    [["is-captain", "blue"], /captains "blue"/],
  ])("maps %j to a validation error and logs nothing", async (verdict, message) => {
    mocks.upstashEval.mockResolvedValueOnce(verdict);
    await expect(forceAddToTeam("red-team", BOB, ADMIN)).rejects.toThrow(message);
    expect(teamDeps.logActivity).not.toHaveBeenCalled();
  });
});

describe("renameUser", () => {
  const auditLine = () => {
    const cmd = allCommands().find((c) => c[0] === "LPUSH");
    return cmd ? JSON.parse(String(cmd[2])) : null;
  };

  it("renames and audits from and to", async () => {
    nameDeps.currentUsername.mockResolvedValue("alice");
    nameDeps.renameUsername.mockResolvedValue("ok");
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));
    expect(await renameUser(OCTO, " Alicia ", ADMIN)).toEqual({ from: "alice", to: "Alicia" });
    expect(nameDeps.renameUsername).toHaveBeenCalledWith(OCTO, " Alicia ");
    expect(auditLine()).toMatchObject({ action: "ops:user-rename", player: OCTO, from: "alice", to: "Alicia", by: ADMIN.id });
  });

  it.each([
    ["taken", "That username is taken."],
    ["invalid", "Usernames are 3 to 30 letters, digits, dots or underscores."],
    ["missing", "No such player."],
  ])("maps %s to a username validation error and audits nothing", async (result, message) => {
    nameDeps.currentUsername.mockResolvedValue(null);
    nameDeps.renameUsername.mockResolvedValue(result);
    const err = await renameUser(OCTO, "bob", ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(OpsValidationError);
    expect(err).toMatchObject({ field: "username", message });
    expect(allCommands().some((c) => c[0] === "LPUSH")).toBe(false);
  });

  it("validates the id before touching the store, and a non-string name is invalid", async () => {
    await expect(renameUser("OctoCat", "bob", ADMIN)).rejects.toThrow("invalid player id");
    expect(nameDeps.renameUsername).not.toHaveBeenCalled();
    nameDeps.currentUsername.mockResolvedValue(null);
    await expect(renameUser(OCTO, 42, ADMIN)).rejects.toMatchObject({ field: "username" });
    expect(nameDeps.renameUsername).not.toHaveBeenCalled();
  });

  it("lets a store failure throw", async () => {
    nameDeps.currentUsername.mockResolvedValue("alice");
    nameDeps.renameUsername.mockRejectedValue(new Error("NOAUTH"));
    await expect(renameUser(OCTO, "bob", ADMIN)).rejects.toThrow("NOAUTH");
  });
});

describe("unlinkGithub", () => {
  const auditLine = () => {
    const cmd = allCommands().find((c) => c[0] === "LPUSH");
    return cmd ? JSON.parse(String(cmd[2])) : null;
  };
  const account = (id: string, providerId: string) => ({ id, providerId, userId: OCTO, accountId: id });

  it("refuses a link that has scored and changes nothing", async () => {
    linkDeps.getGithubLink.mockResolvedValueOnce({ login: "octocat", linkedAt: 1 });
    mockSecureDevKeys("ctf:solves:vampi", [`${OCTO}:api1`, `${BOB}:api1`]);
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    const err = await unlinkGithub(OCTO, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(OpsValidationError);
    expect(err.message).toBe("This GitHub link has scored and cannot be removed.");
    expect(authDeps.deleteAccount).not.toHaveBeenCalled();
    expect(linkDeps.releaseGithubLink).not.toHaveBeenCalled();
    expect(allCommands().some((c) => c[0] === "LPUSH")).toBe(false);
  });

  it("refuses a player whose only sign-in is GitHub", async () => {
    linkDeps.getGithubLink.mockResolvedValueOnce({ login: "octocat", linkedAt: 1 });
    mockSecureDevKeys("ctf:solves:vampi", [`${BOB}:api1`]);
    authDeps.findAccounts.mockResolvedValue([account("a1", "github")]);
    const err = await unlinkGithub(OCTO, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(OpsValidationError);
    expect(err.message).toBe(
      "This player signs in only with GitHub. Give them a reset code so they can set a password first.",
    );
    expect(authDeps.deleteAccount).not.toHaveBeenCalled();
    expect(linkDeps.releaseGithubLink).not.toHaveBeenCalled();
  });

  it("answers no link, not the GitHub-only copy, when the player has no account rows", async () => {
    linkDeps.getGithubLink.mockResolvedValueOnce({ login: "octocat", linkedAt: 1 });
    mockSecureDevKeys("ctf:solves:vampi", [`${BOB}:api1`]);
    authDeps.findAccounts.mockResolvedValue([]);
    const err = await unlinkGithub(OCTO, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(OpsValidationError);
    expect(err.message).toBe("No GitHub account is linked.");
    expect(authDeps.deleteAccount).not.toHaveBeenCalled();
    expect(linkDeps.releaseGithubLink).not.toHaveBeenCalled();
    expect(allCommands().some((c) => c[0] === "LPUSH")).toBe(false);
  });

  it("refuses a player with no link", async () => {
    linkDeps.getGithubLink.mockResolvedValueOnce(null);
    const err = await unlinkGithub(OCTO, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(OpsValidationError);
    expect(err.message).toBe("No GitHub account is linked.");
    expect(authDeps.deleteAccount).not.toHaveBeenCalled();
    expect(linkDeps.releaseGithubLink).not.toHaveBeenCalled();
  });

  it("deletes only the github account rows, releases the link without a block, and audits", async () => {
    linkDeps.getGithubLink.mockResolvedValueOnce({ login: "octocat", linkedAt: 1 });
    mockNoSecureDevKeys();
    authDeps.findAccounts.mockResolvedValue([
      account("a1", "github"),
      account("a2", "credential"),
      account("a3", "github"),
      account("a4", "google"),
    ]);
    authDeps.deleteAccount.mockResolvedValue(undefined);
    linkDeps.releaseGithubLink.mockResolvedValueOnce("octocat");
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // audit
    expect(await unlinkGithub(OCTO, ADMIN)).toEqual({ login: "octocat" });
    expect(authDeps.findAccounts).toHaveBeenCalledWith(OCTO);
    expect(authDeps.deleteAccount.mock.calls.map((c) => c[0])).toEqual(["a1", "a3"]);
    expect(linkDeps.releaseGithubLink).toHaveBeenCalledWith(OCTO, { block: false });
    expect(authDeps.deleteAccount.mock.invocationCallOrder.at(-1)).toBeLessThan(
      linkDeps.releaseGithubLink.mock.invocationCallOrder[0],
    );
    expect(auditLine()).toMatchObject({ action: "ops:github-unlink", player: OCTO, login: "octocat", by: ADMIN.id });
  });

  it("another provider alone counts as a sign-in method", async () => {
    linkDeps.getGithubLink.mockResolvedValueOnce({ login: "octocat", linkedAt: 1 });
    mockNoSecureDevKeys();
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a4", "discord")]);
    linkDeps.releaseGithubLink.mockResolvedValueOnce("octocat");
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));
    expect(await unlinkGithub(OCTO, ADMIN)).toEqual({ login: "octocat" });
    expect(authDeps.deleteAccount.mock.calls.map((c) => c[0])).toEqual(["a1"]);
  });

  it("validates the id first and lets a store failure throw without releasing", async () => {
    await expect(unlinkGithub("OctoCat", ADMIN)).rejects.toThrow("invalid player id");
    expect(linkDeps.getGithubLink).not.toHaveBeenCalled();
    linkDeps.getGithubLink.mockResolvedValueOnce({ login: "octocat", linkedAt: 1 });
    mockNoSecureDevKeys();
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    authDeps.deleteAccount.mockRejectedValueOnce(new Error("auth store: delete failed"));
    await expect(unlinkGithub(OCTO, ADMIN)).rejects.toThrow("auth store");
    expect(linkDeps.releaseGithubLink).not.toHaveBeenCalled();
    expect(allCommands().some((c) => c[0] === "LPUSH")).toBe(false);
  });

  it("a failed SD solve count refuses instead of reading as unscored", async () => {
    linkDeps.getGithubLink.mockResolvedValueOnce({ login: "octocat", linkedAt: 1 });
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH" }]);
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    await expect(unlinkGithub(OCTO, ADMIN)).rejects.toThrow();
    expect(authDeps.deleteAccount).not.toHaveBeenCalled();
    expect(linkDeps.releaseGithubLink).not.toHaveBeenCalled();
  });
});
