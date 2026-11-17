// Per-contestant and per-team support operations (issue #168).
//
// These are the only destructive controls in the kit that act on ONE person,
// so the things worth pinning are the blast radius (does it touch anybody
// else?), the aggregate bookkeeping (the counters are NOT all keyed the same
// way), and the refusals that keep a team administrable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
// unlinkGithub reads the sign-in switches to tell an enabled provider row
// from one that cannot sign in.
const storeDeps = vi.hoisted(() => ({ resetEvent: vi.fn(), scanDelByPrefix: vi.fn(), getAdminSettings: vi.fn() }));
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
// unlinkGithub takes it, and puts it back when it turns out to have scored.
const linkDeps = vi.hoisted(() => ({
  getGithubLink: vi.fn(),
  releaseGithubLink: vi.fn(),
  takeGithubLink: vi.fn(),
  restoreGithubLink: vi.fn(),
  isReleasedAndBlocked: vi.fn(),
}));
vi.mock("@/lib/github-link", () => linkDeps);

// deleteUser and unlinkGithub put the player's scores on hold before their
// first write; a failed delete lifts its own token while the account row is
// still there, an unlink lifts its own token when it ends. The scripts
// themselves run in score-hold.test.ts and the live suite.
const holdDeps = vi.hoisted(() => ({
  holdScores: vi.fn(),
  restoreAfterFailedDelete: vi.fn(),
  releaseScoreHold: vi.fn(),
}));
vi.mock("@/lib/score-hold", () => holdDeps);

// unlinkGithub reads and deletes the player's better-auth account rows and
// clears the GitHub identity on the user row;
// deleteUser removes the user row, its accounts and its sessions.
const authDeps = vi.hoisted(() => ({
  findAccounts: vi.fn(),
  deleteAccount: vi.fn(),
  findUserById: vi.fn(),
  updateUser: vi.fn(),
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
  BLOCKED_DURING_UNLINK,
  CLEAR_HELD_SCRIPT,
  GRANT_CLAIMED_DURING_DELETE,
  ORPHAN_GRANT_REMOVED,
  OpsValidationError,
  RESET_MODULE_SOLVES_SCRIPT,
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

/** What `deleteUser` reads before any write: the lookup (with the team read
 *  when `slug` is set, `captain` naming the captain) and its secure-dev count. */
function queueDeleteLookup(slug: string | null = null, captain: string = BOB, marker: number | null = 0) {
  mocks.upstashPipeline.mockResolvedValueOnce(
    replies(userHmget(slug), [], [], null, null, [], [], null, null, 0, null),
  );
  if (slug) mocks.upstashPipeline.mockResolvedValueOnce(replies("Red Team", captain));
  mockNoSecureDevKeys();
  // null for a delete that throws before it reads the marker.
  if (marker !== null) mocks.upstashPipeline.mockResolvedValueOnce(replies(marker)); // the deleting marker's EXISTS
}

/** The deleting marker's SET, the first write after the hold and the link
 *  release, before the account delete. */
function queueDeleteMark() {
  mocks.upstashPipeline.mockResolvedValueOnce(replies("OK"));
}

/** What `deleteUser` writes once the account row is confirmed gone, in
 *  order: the grant SREM, the held-score clear (`held`), the progress reset
 *  (its secure-dev sweep, the classic script, the quiz/hints pipeline and its
 *  audit), the membership SREM (`team`), the record DEL, the marker DEL and
 *  the delete's audit. `stopAfter` leaves the later
 *  stages unqueued, so a delete that fails there leaves no reply over for the
 *  next test. */
function queueDeleteWrites(
  opts: { grantRemoved?: number; held?: boolean; team?: boolean; stopAfter?: "grant" | "held" | "reset" | "tail" | "audit" } = {},
) {
  const { grantRemoved = 0, held = false, team = false, stopAfter = "audit" } = opts;
  queueDeleteMark();
  mocks.upstashPipeline.mockResolvedValueOnce(replies(grantRemoved)); // grant SREM
  if (stopAfter === "grant") return;
  if (held) mocks.upstashEval.mockResolvedValueOnce(1); // held clear
  if (stopAfter === "held") return;
  mockNoSecureDevKeys(); // the reset's own sweep
  mockModuleResets([0, 0, 0, 0, 0]);
  mockQuizAndHintsPipeline();
  mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // reset audit
  if (stopAfter === "reset") return;
  if (team) mocks.upstashPipeline.mockResolvedValueOnce(replies(1)); // membership SREM
  mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // record DEL
  if (stopAfter === "tail") return;
  mocks.upstashPipeline.mockResolvedValueOnce(replies(1)); // marker DEL
  mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // delete audit
}

beforeEach(() => {
  vi.clearAllMocks();
  linkDeps.getGithubLink.mockResolvedValue(null);
  linkDeps.releaseGithubLink.mockResolvedValue(null);
  linkDeps.isReleasedAndBlocked.mockResolvedValue(false);
  holdDeps.holdScores.mockResolvedValue(undefined);
  holdDeps.restoreAfterFailedDelete.mockResolvedValue("restored");
  holdDeps.releaseScoreHold.mockResolvedValue("released");
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
    queueDeleteLookup("red-team", "0c7aca70-0000-4000-8000-00000000000a");

    await expect(deleteUser("0c7aca70-0000-4000-8000-00000000000a", ADMIN)).rejects.toThrow(/captain/i);
    // and nothing was cleared on the way to that refusal
    expect(allCommands().some((c) => c[0] === "DEL")).toBe(false);
    expect(holdDeps.holdScores).not.toHaveBeenCalled();
  });

  it("removes the membership and the account record", async () => {
    queueDeleteLookup("red-team", "a11ce000-0000-4000-8000-00000000000c");
    queueDeleteWrites({ team: true });

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
    // #553: one bracket around the WHOLE delete, so the in-progress flag
    // stays up through the tail writes (membership, account record) and the
    // close comes after the last write.
    expect(foldCache.beginScoreLowering).toHaveBeenCalledTimes(1);
    expect(foldCache.endScoreLowering).toHaveBeenCalledTimes(1);
    // The lookup before the reset is a READ; the bound is the first WRITE
    // (the account delete).
    expect(foldCache.beginScoreLowering.mock.invocationCallOrder[0]).toBeLessThan(
      authDeps.deleteUserSessions.mock.invocationCallOrder[0],
    );
    expect(Math.max(...foldCache.endScoreLowering.mock.invocationCallOrder)).toBeGreaterThan(
      Math.max(...mocks.upstashPipeline.mock.invocationCallOrder),
    );
  });
});

describe("deleteUser: held Secure Development scores", () => {
  it("clears the linked login's held scores by one script once the account row is gone, link untouched", async () => {
    linkDeps.getGithubLink.mockResolvedValueOnce({ login: "octocat", linkedAt: 1 });
    queueDeleteLookup();
    queueDeleteWrites({ held: true });
    await deleteUser(OCTO, ADMIN);
    // One script, the hash before the author index.
    expect(mocks.upstashEval).toHaveBeenCalledWith(CLEAR_HELD_SCRIPT, ["ctf:sd:held:by:octocat", "ctf:sd:held:authors"], ["octocat"]);
    expect(CLEAR_HELD_SCRIPT.indexOf("DEL")).toBeLessThan(CLEAR_HELD_SCRIPT.indexOf("SREM"));
    const clearAt = mocks.upstashEval.mock.calls.findIndex((c) => c[0] === CLEAR_HELD_SCRIPT);
    const clearOrder = mocks.upstashEval.mock.invocationCallOrder[clearAt];
    // After the account delete and the re-read that confirms it.
    expect(clearOrder).toBeGreaterThan(authDeps.deleteUser.mock.invocationCallOrder[0]);
    expect(clearOrder).toBeGreaterThan(Math.max(...authDeps.findUserById.mock.invocationCallOrder));
    // No pipeline names a held key: the script is the one writer.
    expect(allCommands().some((c) => c.slice(1).some((a) => String(a).startsWith("ctf:sd:held")))).toBe(false);
    expect(allCommands().some((c) => c.slice(1).some((a) => /^ctf:link:/.test(String(a))))).toBe(false);
  });

  it("clears nothing held for an unlinked player", async () => {
    linkDeps.getGithubLink.mockResolvedValueOnce(null);
    queueDeleteLookup();
    queueDeleteWrites();
    await deleteUser(OCTO, ADMIN);
    expect(mocks.upstashEval.mock.calls.some((c) => c[0] === CLEAR_HELD_SCRIPT)).toBe(false);
    expect(allCommands().some((c) => c.slice(1).some((a) => String(a).startsWith("ctf:sd:held")))).toBe(false);
  });

  it("a re-run after a failed account delete clears the held scores of the released login the row still carries", async () => {
    // The first run released (and blocked) the link, then its account delete
    // failed: the lookup finds no link, the row still has the login.
    authDeps.findUserById.mockResolvedValueOnce({ id: OCTO, login: "OctoCat" });
    linkDeps.isReleasedAndBlocked.mockResolvedValueOnce(true);
    queueDeleteLookup();
    queueDeleteWrites({ held: true });
    await deleteUser(OCTO, ADMIN);
    expect(linkDeps.isReleasedAndBlocked).toHaveBeenCalledWith("octocat");
    expect(linkDeps.isReleasedAndBlocked.mock.invocationCallOrder[0]).toBeLessThan(holdDeps.holdScores.mock.invocationCallOrder[0]);
    expect(mocks.upstashEval).toHaveBeenCalledWith(CLEAR_HELD_SCRIPT, ["ctf:sd:held:by:octocat", "ctf:sd:held:authors"], ["octocat"]);
  });

  it("leaves held scores alone for a row login that is linked or not blocked", async () => {
    authDeps.findUserById.mockResolvedValueOnce({ id: OCTO, login: "octocat" });
    queueDeleteLookup();
    queueDeleteWrites();
    await deleteUser(OCTO, ADMIN);
    expect(linkDeps.isReleasedAndBlocked).toHaveBeenCalledWith("octocat");
    expect(mocks.upstashEval.mock.calls.some((c) => c[0] === CLEAR_HELD_SCRIPT)).toBe(false);
  });

  it("a re-run after the account and every counted trace are gone is found by the deleting marker and finishes", async () => {
    // The first run deleted the account and then failed in the reset: what is
    // left (an aggregate field) is nothing the lookup counts.
    authDeps.findUserById.mockResolvedValue(null);
    queueDeleteLookup(null, BOB, 1);
    queueDeleteWrites();
    await expect(deleteUser(OCTO, ADMIN)).resolves.toMatchObject({ leftTeam: null });
    expect(allCommands()).toContainEqual(["HDEL", "ctf:quiz:points", OCTO]);
    // The marker goes on its own, after the record's cleanup batch.
    const calls = mocks.upstashPipeline.mock.calls.map((c) => c[0]);
    const tailAt = calls.findIndex((cmds) => cmds.some((c) => c[0] === "DEL" && c[1] === `ctf:user:${OCTO}`));
    const markAt = calls.findIndex((cmds) => cmds.some((c) => c[0] === "DEL" && c[1] === `ctf:admin:deleting:${OCTO}`));
    expect(calls[markAt]).toEqual([["DEL", `ctf:admin:deleting:${OCTO}`]]);
    expect(calls[tailAt].some((c) => c[1] === `ctf:admin:deleting:${OCTO}`)).toBe(false);
    expect(mocks.upstashPipeline.mock.invocationCallOrder[markAt]).toBeGreaterThan(mocks.upstashPipeline.mock.invocationCallOrder[tailAt]);
  });

  it("without the marker, no account and nothing counted is No such player.", async () => {
    authDeps.findUserById.mockResolvedValue(null);
    queueDeleteLookup(null, BOB, 0);
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow("No such player.");
    expect(holdDeps.holdScores).not.toHaveBeenCalled();
  });

  it("a failed membership removal leaves the record and the marker, so the re-run still finds the team", async () => {
    // First run: the account goes, the reset lands, the membership SREM fails.
    queueDeleteLookup("red-team", BOB);
    queueDeleteWrites({ stopAfter: "reset" });
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "READONLY" }]);
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/delete user membership.*READONLY/);
    const deleted = (key: string) =>
      mocks.upstashPipeline.mock.calls.some((c) => c[0].some((cmd) => cmd[0] === "DEL" && cmd[1] === key));
    // Neither the record (the team's only pointer) nor the marker was touched.
    expect(deleted(`ctf:user:${OCTO}`)).toBe(false);
    expect(deleted(`ctf:admin:deleting:${OCTO}`)).toBe(false);

    // Re-run: no account row; the record still names the team.
    vi.clearAllMocks();
    authDeps.findUserById.mockResolvedValue(null);
    queueDeleteLookup("red-team", BOB, 1);
    queueDeleteWrites({ team: true });
    await expect(deleteUser(OCTO, ADMIN)).resolves.toMatchObject({ leftTeam: "red-team" });
    const calls = mocks.upstashPipeline.mock.calls.map((c) => c[0]);
    const sremAt = calls.findIndex((cmds) => cmds.some((c) => c[0] === "SREM" && c[1] === "ctf:team:red-team:members"));
    const recordAt = calls.findIndex((cmds) => cmds.some((c) => c[0] === "DEL" && c[1] === `ctf:user:${OCTO}`));
    expect(calls[sremAt]).toEqual([["SREM", "ctf:team:red-team:members", OCTO]]);
    expect(sremAt).toBeLessThan(recordAt);
    expect(deleted(`ctf:admin:deleting:${OCTO}`)).toBe(true);
  });

  it("a failed record DEL keeps the marker for the re-run", async () => {
    queueDeleteLookup();
    queueDeleteWrites({ stopAfter: "reset" });
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "READONLY" }, { result: 1 }]);
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/delete user.*READONLY/);
    expect(
      mocks.upstashPipeline.mock.calls.some((c) => c[0].some((cmd) => cmd[0] === "DEL" && cmd[1] === `ctf:admin:deleting:${OCTO}`)),
    ).toBe(false);
  });

  it("sets the deleting marker before the account delete", async () => {
    queueDeleteLookup();
    queueDeleteWrites();
    await deleteUser(OCTO, ADMIN);
    const calls = mocks.upstashPipeline.mock.calls.map((c) => c[0]);
    const setAt = calls.findIndex((cmds) => cmds.some((c) => c[0] === "SET" && c[1] === `ctf:admin:deleting:${OCTO}`));
    expect(setAt).toBeGreaterThan(-1);
    expect(mocks.upstashPipeline.mock.invocationCallOrder[setAt]).toBeLessThan(authDeps.deleteUserSessions.mock.invocationCallOrder[0]);
  });

  it("a failed released-login read aborts before any write", async () => {
    authDeps.findUserById.mockResolvedValueOnce({ id: OCTO, login: "octocat" });
    linkDeps.isReleasedAndBlocked.mockRejectedValueOnce(new Error("github link: GET failed: NOAUTH"));
    queueDeleteLookup();
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/NOAUTH/);
    expect(holdDeps.holdScores).not.toHaveBeenCalled();
    expect(allCommands().some((c) => c[0] === "DEL")).toBe(false);
  });

  it("aborts before any write when the link read fails", async () => {
    linkDeps.getGithubLink.mockRejectedValueOnce(new Error("github link: GET failed: READONLY"));
    queueDeleteLookup(null, BOB, null);
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/github link/);
    expect(foldCache.beginScoreLowering).not.toHaveBeenCalled();
    expect(allCommands().some((c) => c[0] === "DEL")).toBe(false);
  });
});

describe("deleteUser: a failed account delete keeps progress and held scores", () => {
  for (const step of ["deleteUserSessions", "deleteAccounts", "deleteUser"] as const) {
    it(`a failed ${step} writes no progress, held-score, grant or record change`, async () => {
      linkDeps.getGithubLink.mockResolvedValueOnce({ login: "octocat", linkedAt: 1 });
      queueDeleteLookup();
      queueDeleteMark();
      authDeps[step].mockRejectedValueOnce(new Error("auth store: down"));
      await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow("auth store: down");
      // Only the lookup's reads ran: no SD sweep, no classic script, no
      // quiz/hints DEL, no held clear, no grant SREM, no record DEL.
      expect(mocks.upstashPipeline).toHaveBeenCalledTimes(4);
      expect(mocks.upstashEval).not.toHaveBeenCalled();
      expect(allCommands().some((c) => ["DEL", "HDEL", "SREM", "LPUSH"].includes(String(c[0])))).toBe(false);
      expect(holdDeps.restoreAfterFailedDelete).toHaveBeenCalledWith(OCTO, holdDeps.holdScores.mock.calls[0][1]);
    });
  }
});

describe("deleteUser: a failed tail write is not a delete", () => {
  it("rejects when the membership/account pipeline reports an error", async () => {
    queueDeleteLookup();
    queueDeleteWrites({ stopAfter: "reset" });
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "READONLY" }]);
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/READONLY/);
    expect(foldCache.endScoreLowering).toHaveBeenCalledTimes(1);
  });
});

describe("deleteUser: the account and its GitHub login", () => {
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
    expect(holdDeps.holdScores).not.toHaveBeenCalled();
  };

  it("refuses an organizer with the organizer copy and deletes nothing", async () => {
    grantDeps.isAdminGrantee.mockResolvedValue(true);
    queueDeleteLookup();
    const err = await deleteUser(OCTO, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(OpsValidationError);
    expect(err.message).toBe("octocat is an organizer. Revoke their admin access first.");
    expect(grantDeps.isAdminGrantee).toHaveBeenCalledWith(OCTO);
    nothingDeleted();
    expect(foldCache.beginScoreLowering).not.toHaveBeenCalled();
  });

  it("checks the grant before the captaincy", async () => {
    grantDeps.isAdminGrantee.mockResolvedValue(true);
    queueDeleteLookup("red-team", OCTO);
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/organizer/);
    nothingDeleted();
  });

  it("a failed grant read refuses instead of reading as not an organizer", async () => {
    grantDeps.isAdminGrantee.mockRejectedValue(new Error("Upstash SISMEMBER admin grants failed: NOAUTH"));
    queueDeleteLookup(null, BOB, null);
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/NOAUTH/);
    nothingDeleted();
  });

  it("releases the link with a block, deletes sessions, accounts and the user, then the held scores and the progress, then audits", async () => {
    linkDeps.getGithubLink.mockResolvedValueOnce({ login: "octocat", linkedAt: 1 });
    linkDeps.releaseGithubLink.mockResolvedValueOnce("octocat");
    queueDeleteLookup();
    queueDeleteWrites({ held: true });
    await deleteUser(OCTO, ADMIN);

    expect(linkDeps.releaseGithubLink).toHaveBeenCalledWith(OCTO, { block: true });
    expect(authDeps.deleteUserSessions).toHaveBeenCalledWith(OCTO);
    expect(authDeps.deleteAccounts).toHaveBeenCalledWith(OCTO);
    expect(authDeps.deleteUser).toHaveBeenCalledWith(OCTO);
    const evals = mocks.upstashEval.mock.calls.map((c) => c[0]);
    const order = [
      linkDeps.releaseGithubLink.mock.invocationCallOrder[0],
      authDeps.deleteUserSessions.mock.invocationCallOrder[0],
      authDeps.deleteAccounts.mock.invocationCallOrder[0],
      authDeps.deleteUser.mock.invocationCallOrder[0],
      mocks.upstashEval.mock.invocationCallOrder[evals.indexOf(CLEAR_HELD_SCRIPT)], // held clear
      mocks.upstashEval.mock.invocationCallOrder[evals.indexOf(RESET_MODULE_SOLVES_SCRIPT)], // first progress write
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
    queueDeleteLookup();
    queueDeleteWrites();
    await deleteUser(OCTO, ADMIN);
    expect(linkDeps.releaseGithubLink).toHaveBeenCalledWith(OCTO, { block: true });
    expect(auditLine("ops:user-delete")).toMatchObject({ player: OCTO, blockedLogin: null });
  });

  it("deletes an account that holds no event state", async () => {
    queueDeleteLookup();
    queueDeleteWrites();
    await expect(deleteUser(OCTO, ADMIN)).resolves.toMatchObject({ leftTeam: null });
    expect(authDeps.deleteUser).toHaveBeenCalledWith(OCTO);
  });

  it("an id with neither an account nor event state is No such player., and nothing is written", async () => {
    authDeps.findUserById.mockResolvedValue(null);
    queueDeleteLookup();
    const err = await deleteUser(OCTO, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(OpsValidationError);
    expect(err.message).toBe("No such player.");
    nothingDeleted();
  });

  it("event state with no account row is still deleted", async () => {
    authDeps.findUserById.mockResolvedValue(null);
    queueDeleteLookup("red-team", BOB);
    queueDeleteWrites({ team: true });
    await expect(deleteUser(OCTO, ADMIN)).resolves.toMatchObject({ leftTeam: "red-team" });
  });

  it("a failed auth delete rejects with no audit line", async () => {
    linkDeps.releaseGithubLink.mockResolvedValueOnce("octocat");
    queueDeleteLookup();
    queueDeleteMark();
    authDeps.deleteAccounts.mockRejectedValueOnce(new Error("auth store: deleteMany account failed"));
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow("auth store");
    expect(authDeps.deleteUser).not.toHaveBeenCalled();
    expect(auditLine("ops:user-delete")).toBeNull();
    expect(foldCache.endScoreLowering).toHaveBeenCalledTimes(1);
  });

  it("removes the id's admin grant after the account row is gone and the re-read confirms it", async () => {
    queueDeleteLookup();
    queueDeleteWrites();
    const result = await deleteUser(OCTO, ADMIN);
    const calls = mocks.upstashPipeline.mock.calls.map((c) => c[0]);
    const sremAt = calls.findIndex((cmds) => cmds.some((c) => c[0] === "SREM" && c[1] === "ctf:admin:grants"));
    expect(calls[sremAt]).toEqual([["SREM", "ctf:admin:grants", OCTO]]);
    const sremOrder = mocks.upstashPipeline.mock.invocationCallOrder[sremAt];
    expect(sremOrder).toBeGreaterThan(authDeps.deleteUser.mock.invocationCallOrder[0]);
    expect(sremOrder).toBeGreaterThan(Math.max(...authDeps.findUserById.mock.invocationCallOrder));
    expect(result.warnings).not.toContain(GRANT_CLAIMED_DURING_DELETE);
    expect(auditLine("ops:user-delete")).toMatchObject({ grantRemoved: false });
    expect(auditLine("ops:user-delete")).not.toHaveProperty("warning");
  });

  it("a grant claimed during the delete is removed, returned as a warning and audited", async () => {
    queueDeleteLookup();
    queueDeleteWrites({ grantRemoved: 1 });
    const result = await deleteUser(OCTO, ADMIN);
    expect(result.warnings).toContain(GRANT_CLAIMED_DURING_DELETE);
    expect(auditLine("ops:user-delete")).toMatchObject({
      player: OCTO,
      grantRemoved: true,
      warning: GRANT_CLAIMED_DURING_DELETE,
    });
  });

  it("a failed grant removal rejects with no audit line and no progress write", async () => {
    queueDeleteLookup();
    queueDeleteMark();
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "READONLY" }]);
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/admin grant.*READONLY/);
    expect(authDeps.deleteUser).toHaveBeenCalledWith(OCTO);
    expect(auditLine("ops:user-delete")).toBeNull();
    expect(mocks.upstashEval).not.toHaveBeenCalled();
    expect(foldCache.endScoreLowering).toHaveBeenCalledTimes(1);
  });

  it("a retry after a failed grant removal removes the orphaned grant instead of refusing it as an organizer", async () => {
    // The first run deleted the account row, then its grant SREM failed.
    authDeps.findUserById.mockResolvedValue(null);
    grantDeps.isAdminGrantee.mockResolvedValue(true);
    queueDeleteLookup();
    queueDeleteWrites({ grantRemoved: 1 });
    const result = await deleteUser(OCTO, ADMIN);
    expect(allCommands()).toContainEqual(["SREM", "ctf:admin:grants", OCTO]);
    expect(result.warnings).toContain(ORPHAN_GRANT_REMOVED);
    expect(result.warnings).not.toContain(GRANT_CLAIMED_DURING_DELETE);
    expect(auditLine("ops:user-delete")).toMatchObject({ player: OCTO, grantRemoved: true, warning: ORPHAN_GRANT_REMOVED });
    // The no-row retry still marks; with the row already gone it has nothing
    // to restore.
    expect(holdDeps.holdScores).toHaveBeenCalledWith(OCTO, expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(holdDeps.restoreAfterFailedDelete).not.toHaveBeenCalled();
  });

  it("still refuses a grant whose account row is in place", async () => {
    grantDeps.isAdminGrantee.mockResolvedValue(true);
    queueDeleteLookup();
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/is an organizer/);
    nothingDeleted();
  });

  it("a failed account-row read refuses instead of reading as an orphaned grant", async () => {
    grantDeps.isAdminGrantee.mockResolvedValue(true);
    authDeps.findUserById.mockRejectedValue(new Error("NOAUTH"));
    queueDeleteLookup(null, BOB, null);
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow("NOAUTH");
    nothingDeleted();
  });

  it("a user row that survives the delete is a failure, not a delete", async () => {
    // better-auth's single-row delete swallows a failed read and deletes
    // nothing; the re-read is what notices.
    authDeps.deleteUser.mockResolvedValueOnce(undefined);
    queueDeleteLookup();
    queueDeleteMark();
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/account/);
    expect(auditLine("ops:user-delete")).toBeNull();
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });
});

describe("deleteUser: the score hold (#775)", () => {
  it("holds after the refusals and before the link release and every account or progress write", async () => {
    linkDeps.getGithubLink.mockResolvedValueOnce({ login: "octocat", linkedAt: 1 });
    linkDeps.releaseGithubLink.mockResolvedValueOnce("octocat");
    queueDeleteLookup();
    queueDeleteWrites({ held: true });
    await deleteUser(OCTO, ADMIN);

    expect(holdDeps.holdScores).toHaveBeenCalledWith(OCTO, expect.stringMatching(/^[0-9a-f-]{36}$/));
    const order = [
      grantDeps.isAdminGrantee.mock.invocationCallOrder[0],
      holdDeps.holdScores.mock.invocationCallOrder[0],
      linkDeps.releaseGithubLink.mock.invocationCallOrder[0],
      foldCache.beginScoreLowering.mock.invocationCallOrder[0],
      authDeps.deleteUser.mock.invocationCallOrder[0],
      mocks.upstashEval.mock.invocationCallOrder[0], // the held clear, then the classic reset
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(holdDeps.restoreAfterFailedDelete).not.toHaveBeenCalled();
  });

  it("a failed hold writes nothing and restores with the token it tried to add", async () => {
    holdDeps.holdScores.mockRejectedValueOnce(new Error("Upstash EVAL failed: READONLY"));
    holdDeps.restoreAfterFailedDelete.mockResolvedValueOnce("restored");
    queueDeleteLookup();
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/READONLY/);
    expect(linkDeps.releaseGithubLink).not.toHaveBeenCalled();
    expect(foldCache.beginScoreLowering).not.toHaveBeenCalled();
    expect(allCommands().some((c) => c[0] === "DEL" || c[0] === "SREM" || c[0] === "LPUSH")).toBe(false);
    expect(mocks.upstashEval).not.toHaveBeenCalled();
    expect(holdDeps.restoreAfterFailedDelete).toHaveBeenCalledTimes(1);
    expect(holdDeps.restoreAfterFailedDelete).toHaveBeenCalledWith(OCTO, holdDeps.holdScores.mock.calls[0][1]);
  });

  it("a throw before the account row is gone restores with this delete's token and rethrows the original", async () => {
    queueDeleteLookup();
    queueDeleteMark();
    authDeps.deleteAccounts.mockRejectedValueOnce(new Error("auth store: deleteMany account failed"));
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow("auth store: deleteMany account failed");
    expect(holdDeps.restoreAfterFailedDelete).toHaveBeenCalledTimes(1);
    expect(holdDeps.restoreAfterFailedDelete).toHaveBeenCalledWith(OCTO, holdDeps.holdScores.mock.calls[0][1]);
    expect(holdDeps.restoreAfterFailedDelete.mock.invocationCallOrder[0]).toBeGreaterThan(
      authDeps.deleteAccounts.mock.invocationCallOrder[0],
    );
  });

  it("a failed link release restores too", async () => {
    linkDeps.releaseGithubLink.mockRejectedValueOnce(new Error("github link: release failed"));
    queueDeleteLookup();
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow("github link: release failed");
    expect(holdDeps.restoreAfterFailedDelete).toHaveBeenCalledWith(OCTO, holdDeps.holdScores.mock.calls[0][1]);
  });

  it("a user row that survives the delete restores", async () => {
    authDeps.deleteUser.mockResolvedValueOnce(undefined);
    queueDeleteLookup();
    queueDeleteMark();
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/account row is still there/);
    expect(holdDeps.restoreAfterFailedDelete).toHaveBeenCalledWith(OCTO, holdDeps.holdScores.mock.calls[0][1]);
  });

  it("a failed restore is logged with the re-run instruction and the original error is rethrown", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      queueDeleteLookup();
      queueDeleteMark();
      authDeps.deleteAccounts.mockRejectedValueOnce(new Error("auth store: deleteMany account failed"));
      holdDeps.restoreAfterFailedDelete.mockRejectedValueOnce(new Error("Upstash EVAL failed: NOAUTH"));
      await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow("auth store: deleteMany account failed");
      const line = log.mock.calls.find((c) => String(c[0]).includes("score hold"));
      expect(line).toBeDefined();
      expect(String(line![0])).toContain(OCTO);
      expect(String(line![0])).toMatch(/re-run of the delete succeeds/i);
      expect(line![1]).toBe("Error: Upstash EVAL failed: NOAUTH");
    } finally {
      log.mockRestore();
    }
  });

  it("logs ids only when another token of the player stays on the hold", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      queueDeleteLookup();
      queueDeleteMark();
      authDeps.deleteAccounts.mockRejectedValueOnce(new Error("auth store: deleteMany account failed"));
      holdDeps.restoreAfterFailedDelete.mockResolvedValueOnce("in-flight");
      await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow("auth store: deleteMany account failed");
      const line = log.mock.calls.find((c) => String(c[0]).includes("another token"));
      expect(line).toEqual([`[admin-ops] delete ${OCTO} failed; another token remains on the score hold (a delete or unlink running, or failed without lifting it)`]);
    } finally {
      log.mockRestore();
    }
  });

  it("a throw after the row is confirmed gone does not restore", async () => {
    queueDeleteLookup();
    queueDeleteMark();
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "READONLY" }]); // grant SREM
    await expect(deleteUser(OCTO, ADMIN)).rejects.toThrow(/admin grant.*READONLY/);
    expect(holdDeps.restoreAfterFailedDelete).not.toHaveBeenCalled();
  });

  it("does not repeat the reset's 'scored again' warning: a deleted player's PR is refused", async () => {
    queueDeleteLookup();
    queueDeleteMark();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(0)); // grant SREM
    mockSecureDevKeys("ctf:solves:dvwa", [`${OCTO}:c1`]);
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1)); // HDEL of those fields
    mockModuleResets([0, 0, 0, 0, 0]);
    mockQuizAndHintsPipeline();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // reset audit
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // tail
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // delete audit
    const result = await deleteUser(OCTO, ADMIN);
    expect(result.cleared.secureDevSolves).toBe(1);
    expect(result.warnings.join(" ")).not.toMatch(/scored again|re-ingest|HSETNX/i);
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
      "ctf:admin:deleting:*",
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
    expect(storeDeps.scanDelByPrefix.mock.calls.some((c) => "ctf:admin:claim:spent".startsWith(String(c[0]).replaceAll("*", "")))).toBe(false);
    expect(cleared).toEqual({
      solves: 3,
      users: 2,
      auth: "ctf:auth:*".length,
      links: "ctf:link:*".length,
      adminCodes: "ctf:admin:code:*".length,
      resetCodes: "ctf:admin:reset-code:*".length,
      deleting: "ctf:admin:deleting:*".length,
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
  const TAKEN = { login: "octocat", at: "1700000000000", ours: true };
  const GH_AVATAR = "https://avatars.githubusercontent.com/u/583231?v=4";
  const switches = (on: Partial<Record<"github" | "google" | "discord", boolean>>) => ({
    signInProviders: { github: false, google: false, discord: false, ...on },
  });

  beforeEach(() => {
    linkDeps.getGithubLink.mockResolvedValue({ login: "octocat", linkedAt: 1700000000000 });
    linkDeps.takeGithubLink.mockResolvedValue(TAKEN);
    linkDeps.restoreGithubLink.mockResolvedValue("restored");
    nameDeps.currentUsername.mockResolvedValue("octocat");
    authDeps.deleteAccount.mockReset().mockResolvedValue(undefined);
    authDeps.findUserById.mockResolvedValue({ id: OCTO, login: "octocat", image: GH_AVATAR });
    authDeps.updateUser.mockReset().mockResolvedValue(undefined);
    storeDeps.getAdminSettings.mockResolvedValue(switches({}));
    vi.stubEnv("GOOGLE_CLIENT_ID", "id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    vi.stubEnv("DISCORD_CLIENT_ID", "id");
    vi.stubEnv("DISCORD_CLIENT_SECRET", "secret");
  });
  afterEach(() => vi.unstubAllEnvs());

  const nothingWritten = () => {
    expect(holdDeps.holdScores).not.toHaveBeenCalled();
    expect(linkDeps.takeGithubLink).not.toHaveBeenCalled();
    expect(authDeps.deleteAccount).not.toHaveBeenCalled();
    expect(authDeps.updateUser).not.toHaveBeenCalled();
    expect(allCommands().some((c) => c[0] === "LPUSH")).toBe(false);
  };

  it("clears the row's login and GitHub avatar after the solve count and before any account row goes", async () => {
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    mockNoSecureDevKeys();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // audit
    await unlinkGithub(OCTO, ADMIN);
    expect(authDeps.updateUser).toHaveBeenCalledTimes(1);
    expect(authDeps.updateUser).toHaveBeenCalledWith(OCTO, { login: null, image: null });
    const clear = authDeps.updateUser.mock.invocationCallOrder[0];
    expect(mocks.upstashPipeline.mock.invocationCallOrder[0]).toBeLessThan(clear);
    expect(clear).toBeLessThan(authDeps.deleteAccount.mock.invocationCallOrder[0]);
  });

  it.each([
    ["an uploaded image", "https://cdn.example.test/me.png"],
    ["a lookalike host", "https://avatars.githubusercontent.com.evil.test/u/1"],
    ["a non-URL string", "not a url"],
  ])("keeps %s and clears only the login", async (_label, image) => {
    authDeps.findUserById.mockResolvedValue({ id: OCTO, login: "octocat", image });
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    mockNoSecureDevKeys();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // audit
    await unlinkGithub(OCTO, ADMIN);
    expect(authDeps.updateUser).toHaveBeenCalledWith(OCTO, { login: null });
  });

  it("writes nothing to a row that carries no GitHub identity", async () => {
    authDeps.findUserById.mockResolvedValue({ id: OCTO, login: null, image: null });
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    mockNoSecureDevKeys();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // audit
    await unlinkGithub(OCTO, ADMIN);
    expect(authDeps.updateUser).not.toHaveBeenCalled();
    expect(authDeps.deleteAccount).toHaveBeenCalledWith("a1");
  });

  it("a failed row clear deletes no account row, writes no audit line and lifts the hold", async () => {
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    mockNoSecureDevKeys();
    authDeps.updateUser.mockRejectedValueOnce(new Error("auth store: update user failed"));
    await expect(unlinkGithub(OCTO, ADMIN)).rejects.toThrow("update user failed");
    expect(authDeps.deleteAccount).not.toHaveBeenCalled();
    expect(allCommands().some((c) => c[0] === "LPUSH")).toBe(false);
    expect(holdDeps.releaseScoreHold).toHaveBeenCalledWith(OCTO, holdDeps.holdScores.mock.calls[0][1]);
  });

  it("takes the link, finds no solve, then deletes only the github rows and audits", async () => {
    authDeps.findAccounts.mockResolvedValue([
      account("a1", "github"),
      account("a2", "credential"),
      account("a3", "github"),
    ]);
    mockNoSecureDevKeys();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // audit
    expect(await unlinkGithub(OCTO, ADMIN)).toEqual({ login: "octocat" });
    expect(linkDeps.takeGithubLink).toHaveBeenCalledWith(OCTO);
    expect(linkDeps.releaseGithubLink).not.toHaveBeenCalled();
    expect(linkDeps.restoreGithubLink).not.toHaveBeenCalled();
    expect(authDeps.deleteAccount.mock.calls.map((c) => c[0])).toEqual(["a1", "a3"]);
    // The release comes before the solve count, and the count before any row goes.
    const take = linkDeps.takeGithubLink.mock.invocationCallOrder[0];
    const scan = mocks.upstashPipeline.mock.invocationCallOrder[0];
    expect(take).toBeLessThan(scan);
    expect(scan).toBeLessThan(authDeps.deleteAccount.mock.invocationCallOrder[0]);
    expect(auditLine()).toMatchObject({ action: "ops:github-unlink", player: OCTO, login: "octocat", by: ADMIN.id });
  });

  it("puts a scored link back exactly as taken and refuses, deleting nothing", async () => {
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    mockSecureDevKeys("ctf:solves:vampi", [`${OCTO}:api1`, `${BOB}:api1`]);
    const err = await unlinkGithub(OCTO, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(OpsValidationError);
    expect(err.message).toBe("This GitHub link has scored and cannot be removed.");
    expect(linkDeps.restoreGithubLink).toHaveBeenCalledWith(OCTO, TAKEN);
    expect(linkDeps.restoreGithubLink.mock.invocationCallOrder[0]).toBeGreaterThan(
      linkDeps.takeGithubLink.mock.invocationCallOrder[0],
    );
    expect(authDeps.deleteAccount).not.toHaveBeenCalled();
    expect(authDeps.updateUser).not.toHaveBeenCalled();
    expect(allCommands().some((c) => c[0] === "LPUSH")).toBe(false);
  });

  it("holds the player's scores before the take and lifts only its own token after the last write", async () => {
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    mockNoSecureDevKeys();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // audit
    await unlinkGithub(OCTO, ADMIN);
    const [[heldFor, token]] = holdDeps.holdScores.mock.calls;
    expect(heldFor).toBe(OCTO);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(holdDeps.releaseScoreHold).toHaveBeenCalledTimes(1);
    expect(holdDeps.releaseScoreHold).toHaveBeenCalledWith(OCTO, token);
    expect(holdDeps.restoreAfterFailedDelete).not.toHaveBeenCalled();
    // hold -> take -> count -> rows -> audit -> lift
    const hold = holdDeps.holdScores.mock.invocationCallOrder[0];
    const take = linkDeps.takeGithubLink.mock.invocationCallOrder[0];
    const scan = mocks.upstashPipeline.mock.invocationCallOrder[0];
    const rows = authDeps.deleteAccount.mock.invocationCallOrder[0];
    const auditCall = mocks.upstashPipeline.mock.invocationCallOrder.at(-1)!;
    const lift = holdDeps.releaseScoreHold.mock.invocationCallOrder[0];
    expect(hold).toBeLessThan(take);
    expect(take).toBeLessThan(scan);
    expect(scan).toBeLessThan(rows);
    expect(rows).toBeLessThan(auditCall);
    expect(auditCall).toBeLessThan(lift);
  });

  it("a scored link is put back under the hold, and the hold is lifted after the restore", async () => {
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    mockSecureDevKeys("ctf:solves:vampi", [`${OCTO}:api1`]);
    await expect(unlinkGithub(OCTO, ADMIN)).rejects.toThrow("This GitHub link has scored and cannot be removed.");
    expect(holdDeps.holdScores.mock.invocationCallOrder[0]).toBeLessThan(linkDeps.takeGithubLink.mock.invocationCallOrder[0]);
    expect(linkDeps.restoreGithubLink.mock.invocationCallOrder[0]).toBeLessThan(
      holdDeps.releaseScoreHold.mock.invocationCallOrder[0],
    );
    expect(holdDeps.releaseScoreHold).toHaveBeenCalledWith(OCTO, holdDeps.holdScores.mock.calls[0][1]);
  });

  it("a failed hold takes nothing and still lifts the token it tried to add", async () => {
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    holdDeps.holdScores.mockRejectedValueOnce(new Error("Upstash EVAL failed: READONLY"));
    await expect(unlinkGithub(OCTO, ADMIN)).rejects.toThrow("READONLY");
    expect(linkDeps.takeGithubLink).not.toHaveBeenCalled();
    expect(authDeps.deleteAccount).not.toHaveBeenCalled();
    expect(holdDeps.releaseScoreHold).toHaveBeenCalledWith(OCTO, holdDeps.holdScores.mock.calls[0][1]);
  });

  it("a failed lift is logged and does not undo or mask a finished unlink", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    mockNoSecureDevKeys();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // audit
    holdDeps.releaseScoreHold.mockRejectedValueOnce(new Error("Upstash EVAL failed: NOAUTH"));
    expect(await unlinkGithub(OCTO, ADMIN)).toEqual({ login: "octocat" });
    expect(log.mock.calls.some((c) => String(c[0]).includes("score hold"))).toBe(true);
    log.mockRestore();
  });

  it("a player deleted during the unlink gets no link back and the unlink refuses", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH" }]);
    linkDeps.restoreGithubLink.mockResolvedValueOnce("deleted");
    const err = await unlinkGithub(OCTO, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(OpsValidationError);
    expect(err.message).toBe("This player was deleted while the unlink ran.");
    expect(log.mock.calls.flat().join(" ")).not.toContain("octocat");
    expect(authDeps.deleteAccount).not.toHaveBeenCalled();
    expect(holdDeps.releaseScoreHold).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("a scored link whose login was blocked during the unlink gets no link back and the unlink refuses", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
      mocks.upstashPipeline.mockResolvedValueOnce(replies(["0", ["ctf:solves:dvwa"]]));
      mocks.upstashPipeline.mockResolvedValueOnce(replies([`${OCTO}:c1`]));
      linkDeps.restoreGithubLink.mockResolvedValueOnce("blocked");
      const err = await unlinkGithub(OCTO, ADMIN).catch((e) => e);
      expect(err).toBeInstanceOf(OpsValidationError);
      expect(err.message).toBe(BLOCKED_DURING_UNLINK);
      expect(linkDeps.restoreGithubLink).toHaveBeenCalledWith(OCTO, TAKEN);
      expect(log.mock.calls.flat().join(" ")).not.toContain("octocat");
      expect(authDeps.deleteAccount).not.toHaveBeenCalled();
      expect(allCommands().some((c) => c[0] === "LPUSH")).toBe(false);
      expect(holdDeps.releaseScoreHold).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it("a failed solve count puts the link back and throws instead of reading as unscored", async () => {
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH" }]);
    await expect(unlinkGithub(OCTO, ADMIN)).rejects.toThrow();
    expect(linkDeps.restoreGithubLink).toHaveBeenCalledWith(OCTO, TAKEN);
    expect(authDeps.deleteAccount).not.toHaveBeenCalled();
  });

  it("a scored link that cannot be put back throws, not the refusal copy", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    mockSecureDevKeys("ctf:solves:vampi", [`${OCTO}:api1`]);
    linkDeps.restoreGithubLink.mockRejectedValueOnce(new Error("github link: restore refused (taken)"));
    const err = await unlinkGithub(OCTO, ADMIN).catch((e) => e);
    expect(err).not.toBeInstanceOf(OpsValidationError);
    expect(err.message).toMatch(/restore refused/);
    expect(log.mock.calls.flat().join(" ")).not.toContain("octocat");
    expect(authDeps.deleteAccount).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it.each([
    [
      "GitHub alone",
      [account("a1", "github")],
      "octocat",
      "This player cannot sign in without GitHub. First give them a reset code so they can set a password.",
    ],
    [
      "a password but no username",
      [account("a1", "github"), account("a2", "credential")],
      null,
      "This player cannot sign in without GitHub. First set a username for them (Username, then Save).",
    ],
    [
      "neither a password nor a username",
      [account("a1", "github")],
      null,
      "This player cannot sign in without GitHub. First set a username for them (Username, then Save), then give them a reset code so they can set a password.",
    ],
    [
      "a provider that is switched off",
      [account("a1", "github"), account("a4", "discord")],
      "octocat",
      "This player cannot sign in without GitHub. First give them a reset code so they can set a password.",
    ],
  ])("refuses a player with %s, before any write", async (_label, rows, username, message) => {
    authDeps.findAccounts.mockResolvedValue(rows);
    nameDeps.currentUsername.mockResolvedValue(username);
    storeDeps.getAdminSettings.mockResolvedValue(switches({ google: true }));
    const err = await unlinkGithub(OCTO, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(OpsValidationError);
    expect(err.message).toBe(message);
    nothingWritten();
  });

  it("refuses a provider whose switch is on but has no keys", async () => {
    vi.stubEnv("DISCORD_CLIENT_SECRET", "");
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a4", "discord")]);
    storeDeps.getAdminSettings.mockResolvedValue(switches({ discord: true }));
    await expect(unlinkGithub(OCTO, ADMIN)).rejects.toThrow(/cannot sign in without GitHub/);
    nothingWritten();
  });

  it("an enabled provider counts as a sign-in method", async () => {
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a4", "discord")]);
    nameDeps.currentUsername.mockResolvedValue(null);
    storeDeps.getAdminSettings.mockResolvedValue(switches({ discord: true }));
    mockNoSecureDevKeys();
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1));
    expect(await unlinkGithub(OCTO, ADMIN)).toEqual({ login: "octocat" });
    expect(authDeps.deleteAccount.mock.calls.map((c) => c[0])).toEqual(["a1"]);
  });

  it("a failed sign-in switch read refuses instead of reading as enabled", async () => {
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a4", "google")]);
    storeDeps.getAdminSettings.mockRejectedValue(new Error("NOAUTH"));
    nameDeps.currentUsername.mockResolvedValue(null);
    await expect(unlinkGithub(OCTO, ADMIN)).rejects.toThrow("NOAUTH");
    nothingWritten();
  });

  it("answers no link, not the sign-in copy, when the player has no account rows", async () => {
    authDeps.findAccounts.mockResolvedValue([]);
    const err = await unlinkGithub(OCTO, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(OpsValidationError);
    expect(err.message).toBe("No GitHub account is linked.");
    nothingWritten();
  });

  it("refuses a player with neither a link nor a github row", async () => {
    linkDeps.getGithubLink.mockResolvedValue(null);
    authDeps.findAccounts.mockResolvedValue([account("a2", "credential")]);
    const err = await unlinkGithub(OCTO, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(OpsValidationError);
    expect(err.message).toBe("No GitHub account is linked.");
    nothingWritten();
  });

  it("a retry after the link went finishes deleting the github rows", async () => {
    linkDeps.getGithubLink.mockResolvedValue(null);
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    mocks.upstashPipeline.mockResolvedValueOnce(replies(1, 1)); // audit
    expect(await unlinkGithub(OCTO, ADMIN)).toEqual({ login: null });
    expect(linkDeps.takeGithubLink).not.toHaveBeenCalled();
    expect(authDeps.deleteAccount.mock.calls.map((c) => c[0])).toEqual(["a1"]);
    expect(auditLine()).toMatchObject({ action: "ops:github-unlink", player: OCTO, login: null });
  });

  it("validates the id first, and a failed row delete leaves no audit line", async () => {
    await expect(unlinkGithub("OctoCat", ADMIN)).rejects.toThrow("invalid player id");
    expect(linkDeps.getGithubLink).not.toHaveBeenCalled();
    authDeps.findAccounts.mockResolvedValue([account("a1", "github"), account("a2", "credential")]);
    mockNoSecureDevKeys();
    authDeps.deleteAccount.mockRejectedValueOnce(new Error("auth store: delete failed"));
    await expect(unlinkGithub(OCTO, ADMIN)).rejects.toThrow("auth store");
    expect(allCommands().some((c) => c[0] === "LPUSH")).toBe(false);
  });
});
