// Unit tests for the team store's membership rules — most importantly that a
// GitHub user can only ever be on ONE team, a team caps at TEAM_MAX_MEMBERS
// players, joining resolves a captain-shared join code to a team, and every
// captain-only roster action is guarded atomically inside its Lua script.
// Upstash and next/headers are mocked; the end-to-end Lua behavior is
// covered by team-store.upstash.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashEval: vi.fn<(script: string, keys: string[], args: (string | number)[]) => Promise<unknown>>(),
  upstashPipeline: vi.fn<(commands: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
  logActivity: vi.fn<(type: string, login: string, detail?: string) => Promise<void>>(),
  cookieJar: new Map<string, string>(),
}));

vi.mock("server-only", () => ({}));
// The two I/O functions are mocked; `parseScanPage` is the REAL one, taken
// from the original module. It is pure (a reply in, a page or a throw out),
// and a hand-written stub of it here would be the thing under test in the
// SCAN cases below — the store would be checked against a local imitation of
// the parser rather than the parser it actually calls.
vi.mock("@/lib/upstash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/upstash")>();
  return {
    assertPipelineOk: actual.assertPipelineOk,
    parseScanPage: actual.parseScanPage,
    upstashEval: mocks.upstashEval,
    upstashPipeline: mocks.upstashPipeline,
  };
});
// Mocked (not the real fail-open writer) so the pipeline-count pins below
// keep counting only the store's OWN Redis traffic. The store->log wiring is
// pinned in the "activity log" describe at the bottom.
vi.mock("@/lib/activity-log", () => ({ logActivity: mocks.logActivity }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (mocks.cookieJar.has(name) ? { name, value: mocks.cookieJar.get(name) } : undefined),
    set: (name: string, value: string) => void mocks.cookieJar.set(name, value),
    delete: (name: string) => void mocks.cookieJar.delete(name),
  }),
}));

type TeamStore = typeof import("@/lib/team-store");

/** TEAM_WRITES_ENABLED is read at module load, so each test re-imports the
 *  store with the env it needs. */
async function loadStore(writesEnabled: boolean): Promise<TeamStore> {
  vi.resetModules();
  vi.stubEnv("TEAM_WRITES_ENABLED", writesEnabled ? "true" : "");
  return import("@/lib/team-store");
}

/** Every live write path (create/join + captain roster actions, but NOT
 *  leave) reads the registration window first via HMGET
 *  [teamRegistrationOpen, registrationStartsAt, registrationEndsAt]. These
 *  queue that reply: [null,null,null] means open (defaults); a "0" toggle or
 *  an out-of-window date means closed. */
function mockRegistrationOpen() {
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: [null, null, null] }]);
}
function mockRegistrationClosed() {
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["0", null, null] }]);
}

/** Queues the pipeline response for joinTeam's join-code -> slug lookup. */
function mockCodeLookup(slug: string | null) {
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: slug }]);
}

/** Queues the pipeline response for createTeam/regenerateCode's join-code
 *  collision check (generateUniqueJoinCode's EXISTS probe). */
function mockCodeCollisionCheck(exists: boolean) {
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: exists ? 1 : 0 }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.cookieJar.clear();
});

describe("one team per player", () => {
  it("rejects joining a second team and tells the user why", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("red-team");
    mocks.upstashEval.mockResolvedValueOnce("already-on-team");
    const result = await store.joinTeam("octocat", "somecode");
    expect(result).toEqual({ ok: false, error: "Leave your current team before joining another" });
  });

  it("rejects creating a team while already on one", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeCollisionCheck(false);
    mocks.upstashEval.mockResolvedValueOnce("already-on-team");
    const result = await store.createTeam("octocat", "Blue Team");
    expect(result).toEqual({ ok: false, error: "Leave your current team before creating one" });
  });

  it("guards membership BEFORE any write inside the join script (atomic)", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("red-team");
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.joinTeam("octocat", "somecode");
    const [script] = mocks.upstashEval.mock.calls[0];
    const guard = script.indexOf("already-on-team");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(script.indexOf("SADD"));
    expect(guard).toBeLessThan(script.indexOf("HSET"));
  });

  it("guards membership BEFORE any write inside the create script (atomic)", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeCollisionCheck(false);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.createTeam("octocat", "Red Team");
    const [script] = mocks.upstashEval.mock.calls[0];
    const guard = script.indexOf("already-on-team");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(script.indexOf("SADD"));
    expect(guard).toBeLessThan(script.indexOf("HSET"));
  });

  it("keys membership by the server-derived login, not client input", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("red-team");
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.joinTeam("octocat", "somecode");
    const [, keys, args] = mocks.upstashEval.mock.calls[0];
    expect(keys).toEqual(["ctf:user:octocat", "ctf:team:red-team", "ctf:team:red-team:members"]);
    expect(args[0]).toBe("octocat");
  });
});

describe("team size cap", () => {
  it("rejects the fifth player with a clear message", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("red-team");
    mocks.upstashEval.mockResolvedValueOnce("full");
    const result = await store.joinTeam("octocat", "somecode");
    expect(result).toEqual({ ok: false, error: "Team is full (4 players max)" });
  });

  it("passes TEAM_MAX_MEMBERS (4) into the atomic script", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("red-team");
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.joinTeam("octocat", "somecode");
    const [script, , args] = mocks.upstashEval.mock.calls[0];
    expect(store.TEAM_MAX_MEMBERS).toBe(4);
    expect(args).toContain(4);
    expect(script).toContain("SCARD");
  });
});

describe("join by code", () => {
  it("resolves the code to a team and joins it", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("red-team");
    mocks.upstashEval.mockResolvedValueOnce("ok");
    const result = await store.joinTeam("octocat", "somecode");
    expect(result).toEqual({ ok: true, team: "red-team" });
  });

  it("normalizes the code's case before resolving it", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("red-team");
    mocks.upstashEval.mockResolvedValueOnce("ok");
    const result = await store.joinTeam("octocat", "  ABC123  ");
    expect(result).toEqual({ ok: true, team: "red-team" });
    // calls[0] is the registration HGET; the code lookup is the next call.
    expect(mocks.upstashPipeline.mock.calls[1][0]).toEqual([["GET", "ctf:joincode:abc123"]]);
  });

  it("rejects an unknown join code without touching the join script", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup(null);
    const result = await store.joinTeam("octocat", "ghostcode");
    expect(result).toEqual({ ok: false, error: "Invalid or expired join code" });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("requires a non-empty code", async () => {
    const store = await loadStore(true);
    const result = await store.joinTeam("octocat", "   ");
    expect(result).toEqual({ ok: false, error: "Join code is required" });
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("maps a stale team (resolved but since removed) to a friendly error", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("ghost-team");
    mocks.upstashEval.mockResolvedValueOnce("not-found");
    const result = await store.joinTeam("octocat", "somecode");
    expect(result).toEqual({ ok: false, error: "That team no longer exists" });
  });
});

describe("create input handling", () => {
  it("requires a team name to create", async () => {
    const store = await loadStore(true);
    const result = await store.createTeam("octocat", "   ");
    expect(result).toEqual({ ok: false, error: "Team name is required" });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("caps the team name length", async () => {
    const store = await loadStore(true);
    const result = await store.createTeam("octocat", "x".repeat(33));
    expect(result.ok).toBe(false);
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("stores the display name, a slugified id, and a generated join code", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeCollisionCheck(false);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    const result = await store.createTeam("octocat", "The A-Team!!!");
    expect(result).toEqual({ ok: true, team: "the-a-team" });
    const [, keys, args] = mocks.upstashEval.mock.calls[0];
    expect(keys[1]).toBe("ctf:team:the-a-team");
    expect(keys[3]).toMatch(/^ctf:joincode:[a-z0-9]{6}$/);
    expect(args).toContain("The A-Team!!!");
    expect(args).toContain("the-a-team");
    expect(args[4]).toMatch(/^[a-z0-9]{6}$/);
  });

  it("retries join code generation on a collision", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeCollisionCheck(true); // first candidate collides
    mockCodeCollisionCheck(false); // second candidate is free
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.createTeam("octocat", "Red Team");
    // registration read + two collision probes.
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(3);
  });
});

// CodeQL js/biased-cryptographic-random (#435): `randomBytes(n)[i] % 31`
// favours the first 256 % 31 = 8 symbols (9/256 vs 8/256). Each symbol must
// come from an unbiased draw over exactly the alphabet — node:crypto's
// randomInt(0, 31), which rejection-samples internally. The fake randomInt
// below walks every index once, so the pin checks the bounds, that each
// index maps to its own symbol (no symbol is reachable twice), and that
// nothing reads a raw byte and reduces it.
describe("join code generation", () => {
  const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

  it("draws each symbol with randomInt over the alphabet, never a reduced byte", async () => {
    const draws: [number, number][] = [];
    let next = 0;
    vi.doMock("node:crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:crypto")>();
      return {
        ...actual,
        randomBytes: () => {
          throw new Error("join codes must not reduce raw bytes modulo the alphabet");
        },
        randomInt: (min: number, max: number) => {
          draws.push([min, max]);
          return next++ % ALPHABET.length;
        },
      };
    });
    try {
      const store = await loadStore(true);
      const codes: string[] = [];
      // 31 symbols / 6 per code: six codes walk indices 0..35, i.e. every
      // symbol at least once.
      for (let i = 0; i < 6; i++) {
        mockRegistrationOpen();
        mockCodeCollisionCheck(false);
        mocks.upstashEval.mockResolvedValueOnce("ok");
        const result = await store.createTeam(`player${i}`, `Team ${i}`);
        expect(result.ok).toBe(true);
        codes.push(String(mocks.upstashEval.mock.calls[i][2][4]));
      }
      expect(draws.length).toBe(36);
      expect(draws.every(([min, max]) => min === 0 && max === ALPHABET.length)).toBe(true);
      const expected = Array.from({ length: 36 }, (_, i) => ALPHABET[i % ALPHABET.length]).join("");
      expect(codes.join("")).toBe(expected);
    } finally {
      vi.doUnmock("node:crypto");
    }
  });
});

describe("registration window", () => {
  it("rejects createTeam when registration is closed, without mutating", async () => {
    const store = await loadStore(true);
    mockRegistrationClosed();
    const result = await store.createTeam("octocat", "Red Team");
    expect(result).toEqual({ ok: false, error: "Team registration is closed" });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("rejects joinTeam when registration is closed, without mutating", async () => {
    const store = await loadStore(true);
    mockRegistrationClosed();
    const result = await store.joinTeam("octocat", "somecode");
    expect(result).toEqual({ ok: false, error: "Team registration is closed" });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("rejects createTeam when the scheduled window has ended (toggle open, date past)", async () => {
    const store = await loadStore(true);
    // teamRegistrationOpen absent (=open), but registrationEndsAt is in the past.
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: [null, null, "2000-01-01T00:00:00.000Z"] }]);
    const result = await store.createTeam("octocat", "Red Team");
    expect(result).toEqual({ ok: false, error: "Team registration is closed" });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  // Fail-direction pin (issue #232): registration must stay open on either
  // read-error shape, matching resolveTeamMaxMembers's fail-open reasoning —
  // the create/join Lua script still validates every real invariant. Both
  // shapes must also be LOGGED, not just silently defaulted (CodeRabbit
  // catch on PR #277: the per-command shape used to decode as empty settings
  // with no trace).
  it("fails OPEN (create proceeds) and logs when the registration read errors (transport failure)", async () => {
    const store = await loadStore(true);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.upstashPipeline.mockRejectedValueOnce(new Error("redis down"));
      mockCodeCollisionCheck(false);
      mocks.upstashEval.mockResolvedValueOnce("ok");
      const result = await store.createTeam("octocat", "Red Team");
      expect(result).toEqual({ ok: true, team: "red-team" });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("isRegistrationClosed"), expect.stringContaining("redis down"));
    } finally {
      spy.mockRestore();
    }
  });

  it("fails OPEN (create proceeds) and logs when the registration read is a per-command error", async () => {
    const store = await loadStore(true);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.upstashPipeline.mockResolvedValueOnce([{ error: "WRONGTYPE" }]);
      mockCodeCollisionCheck(false);
      mocks.upstashEval.mockResolvedValueOnce("ok");
      const result = await store.createTeam("octocat", "Red Team");
      expect(result).toEqual({ ok: true, team: "red-team" });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("isRegistrationClosed"), expect.stringContaining("WRONGTYPE"));
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects roster-growth captain actions when registration is closed", async () => {
    const store = await loadStore(true);
    const closed = { ok: false, error: "Team registration is closed" };
    for (const call of [
      () => store.removeMember("captain", "red-team", "member2"),
      () => store.renameTeam("captain", "red-team", "New Name"),
      () => store.regenerateCode("captain", "red-team"),
    ]) {
      mockRegistrationClosed();
      expect(await call()).toEqual(closed);
    }
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("still allows transfer and disband when registration is closed (a captain must never be trapped)", async () => {
    const store = await loadStore(true);
    // Neither reads the registration window, so no mockRegistration* is queued.
    mocks.upstashEval.mockResolvedValueOnce("ok"); // transfer
    expect(await store.transferCaptain("captain", "red-team", "member2")).toEqual({ ok: true, team: "red-team" });
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "abc123" }]); // disband's joinCode HGET
    mocks.upstashEval.mockResolvedValueOnce("ok"); // disband
    expect(await store.disbandTeam("captain", "red-team")).toEqual({ ok: true, team: null });
  });

  it("allows createTeam when registration is open (field absent)", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeCollisionCheck(false);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    expect(await store.createTeam("octocat", "Red Team")).toEqual({ ok: true, team: "red-team" });
  });

  it("never blocks leaveTeam — players can always leave", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "red-team" }]); // getUserTeamSlug
    mocks.upstashEval.mockResolvedValueOnce("ok");
    const result = await store.leaveTeam("captain");
    expect(result).toEqual({ ok: true, team: null });
    // Only the membership lookup ran — no registration HGET was issued.
    expect(mocks.upstashPipeline).toHaveBeenCalledOnce();
  });
});

describe("leaveTeam", () => {
  it("leaves the current team", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "red-team" }]);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    const result = await store.leaveTeam("octocat");
    expect(result).toEqual({ ok: true, team: null });
    expect(mocks.upstashEval.mock.calls[0][1]).toEqual([
      "ctf:user:octocat",
      "ctf:team:red-team",
      "ctf:team:red-team:members",
    ]);
  });

  it("deletes the orphan join code when the last member leaves", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "red-team" }]);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.leaveTeam("captain");
    const [script] = mocks.upstashEval.mock.calls[0];
    // When the roster empties, the team hash's joinCode is read and its
    // reverse index deleted so no code is left pointing at a dead team.
    expect(script).toContain("joinCode");
    expect(script).toContain("ctf:joincode:");
    const emptied = script.indexOf("SCARD");
    const readCode = script.indexOf("'joinCode'");
    const delCode = script.indexOf("'ctf:joincode:'");
    expect(readCode).toBeGreaterThan(emptied);
    expect(delCode).toBeGreaterThan(readCode);
  });

  it("is a no-op when the player has no team", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    const result = await store.leaveTeam("octocat");
    expect(result).toEqual({ ok: true, team: null });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("blocks the captain from leaving a populated team", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "red-team" }]);
    mocks.upstashEval.mockResolvedValueOnce("captain-must-transfer");
    const result = await store.leaveTeam("captain");
    expect(result).toEqual({ ok: false, error: "Transfer or disband before leaving" });
  });

  it("lets the old captain leave after transferring captaincy", async () => {
    const store = await loadStore(true);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    const transferResult = await store.transferCaptain("captain", "red-team", "member2");
    expect(transferResult).toEqual({ ok: true, team: "red-team" });

    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "red-team" }]);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    const leaveResult = await store.leaveTeam("captain");
    expect(leaveResult).toEqual({ ok: true, team: null });
  });
});

describe("getViewerTeam", () => {
  it("returns slug, display name, and sorted members", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline
      .mockResolvedValueOnce([{ result: "red-team" }])
      .mockResolvedValueOnce([{ result: "Red Team" }, { result: ["zed", "abe"] }]);
    const team = await store.getViewerTeam("octocat");
    expect(team).toEqual({ slug: "red-team", name: "Red Team", members: ["abe", "zed"] });
  });

  it("returns null when the player has no team", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    expect(await store.getViewerTeam("octocat")).toBeNull();
  });
});

describe("listTeams", () => {
  it("walks the SCAN cursor and resolves each team's name and members", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline
      // Two SCAN pages, then one HGET+SMEMBERS pair per team.
      .mockResolvedValueOnce([{ result: ["7", ["ctf:team:red:members"]] }])
      .mockResolvedValueOnce([{ result: ["0", ["ctf:team:blue:members"]] }])
      .mockResolvedValueOnce([
        { result: "Red Team" },
        { result: ["zed", "abe"] },
        { result: null },
        { result: ["solo"] },
      ]);
    const teams = await store.listTeams();
    expect(teams).toEqual([
      { slug: "red", name: "Red Team", members: ["abe", "zed"] },
      { slug: "blue", name: "blue", members: ["solo"] }, // name falls back to slug
    ]);
    const scanCalls = mocks.upstashPipeline.mock.calls.slice(0, 2).map(([cmds]) => cmds[0]);
    expect(scanCalls[0]).toEqual(["SCAN", "0", "MATCH", "ctf:team:*:members", "COUNT", "1000"]);
    expect(scanCalls[1][1]).toBe("7");
  });

  it("returns [] without touching Upstash when writes are disabled", async () => {
    const store = await loadStore(false);
    expect(await store.listTeams()).toEqual([]);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("returns [] when no team keys exist", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["0", []] }]);
    expect(await store.listTeams()).toEqual([]);
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
  });

  // Issue #358. The PARTIAL case is the one that matters: first page succeeds,
  // second fails. `upstashPipeline` reports that as `{ error }` rather than
  // throwing, and the old fallback read it as cursor "0" — the value meaning
  // "iteration complete" — so the walk ended and returned the first page as if
  // it were the whole keyspace. A team that exists in Redis, and renders on its
  // own /profile, was simply absent from the leaderboard.
  //
  // Asserting only the all-pages-fail case would NOT catch that: a first-page
  // failure returned [] under the old code too, so such a test passes against
  // the bug it is meant to prevent.
  it("rejects when a later SCAN page fails, rather than returning the pages it already has", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline
      .mockResolvedValueOnce([{ result: ["7", ["ctf:team:red:members"]] }])
      .mockResolvedValueOnce([{ error: "ERR max requests limit exceeded" }]);
    await expect(store.listTeams()).rejects.toThrow(/SCAN failed \(listTeams\)/);
  });

  it("rejects a malformed SCAN reply rather than treating it as the end of the walk", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline
      .mockResolvedValueOnce([{ result: ["7", ["ctf:team:red:members"]] }])
      .mockResolvedValueOnce([{ result: "not-a-page" }]);
    await expect(store.listTeams()).rejects.toThrow(/unexpected shape/);
  });
});

describe("captain guard", () => {
  it("rejects removeMember from a non-captain", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mocks.upstashEval.mockResolvedValueOnce("not-captain");
    const result = await store.removeMember("intruder", "red-team", "victim");
    expect(result).toEqual({ ok: false, error: "Only the team captain can do that" });
  });

  it("rejects renameTeam from a non-captain", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mocks.upstashEval.mockResolvedValueOnce("not-captain");
    const result = await store.renameTeam("intruder", "red-team", "New Name");
    expect(result).toEqual({ ok: false, error: "Only the team captain can do that" });
  });

  it("rejects transferCaptain from a non-captain", async () => {
    const store = await loadStore(true);
    mocks.upstashEval.mockResolvedValueOnce("not-captain");
    const result = await store.transferCaptain("intruder", "red-team", "member2");
    expect(result).toEqual({ ok: false, error: "Only the team captain can do that" });
  });

  it("rejects disbandTeam from a non-captain", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "abc123" }]);
    mocks.upstashEval.mockResolvedValueOnce("not-captain");
    const result = await store.disbandTeam("intruder", "red-team");
    expect(result).toEqual({ ok: false, error: "Only the team captain can do that" });
  });

  it("rejects regenerateCode from a non-captain", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "old123" }]);
    mockCodeCollisionCheck(false);
    mocks.upstashEval.mockResolvedValueOnce("not-captain");
    const result = await store.regenerateCode("intruder", "red-team");
    expect(result).toEqual({ ok: false, error: "Only the team captain can do that" });
  });
});

describe("captain roster actions", () => {
  it("removes a member from the roster", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mocks.upstashEval.mockResolvedValueOnce("ok");
    const result = await store.removeMember("captain", "red-team", "member2");
    expect(result).toEqual({ ok: true, team: "red-team" });
    const [script, keys, args] = mocks.upstashEval.mock.calls[0];
    expect(keys).toEqual(["ctf:team:red-team", "ctf:team:red-team:members", "ctf:user:member2"]);
    expect(args).toEqual(["captain", "member2"]);
    expect(script).toContain("SREM");
  });

  it("rejects removing the captain", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mocks.upstashEval.mockResolvedValueOnce("cannot-remove-captain");
    const result = await store.removeMember("captain", "red-team", "captain");
    expect(result).toEqual({
      ok: false,
      error: "The captain can't remove themselves — transfer captaincy or disband instead",
    });
  });

  it("rejects removing someone not on the team", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mocks.upstashEval.mockResolvedValueOnce("not-member");
    const result = await store.removeMember("captain", "red-team", "ghost");
    expect(result).toEqual({ ok: false, error: '"ghost" is not on this team' });
  });

  it("renames the team", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mocks.upstashEval.mockResolvedValueOnce("ok");
    const result = await store.renameTeam("captain", "red-team", "Crimson Squad");
    expect(result).toEqual({ ok: true, team: "red-team" });
    const [, keys, args] = mocks.upstashEval.mock.calls[0];
    expect(keys).toEqual(["ctf:team:red-team", "ctf:team:crimson-squad"]);
    expect(args).toEqual(["captain", "Crimson Squad"]);
  });

  it("rejects a name collision with another team", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mocks.upstashEval.mockResolvedValueOnce("name-taken");
    const result = await store.renameTeam("captain", "red-team", "Blue Team");
    expect(result).toEqual({ ok: false, error: 'Team "blue-team" already exists. Choose another name' });
  });

  it("caps the new name length without calling Upstash", async () => {
    const store = await loadStore(true);
    const result = await store.renameTeam("captain", "red-team", "x".repeat(33));
    expect(result.ok).toBe(false);
    expect(mocks.upstashEval).not.toHaveBeenCalled();
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("transfers captaincy to a current member", async () => {
    const store = await loadStore(true);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    const result = await store.transferCaptain("captain", "red-team", "member2");
    expect(result).toEqual({ ok: true, team: "red-team" });
    const [, keys, args] = mocks.upstashEval.mock.calls[0];
    expect(keys).toEqual(["ctf:team:red-team", "ctf:team:red-team:members"]);
    expect(args).toEqual(["captain", "member2"]);
  });

  it("rejects transferring to someone not on the team", async () => {
    const store = await loadStore(true);
    mocks.upstashEval.mockResolvedValueOnce("not-member");
    const result = await store.transferCaptain("captain", "red-team", "ghost");
    expect(result).toEqual({ ok: false, error: '"ghost" is not on this team' });
  });

  it("disbands the team and clears its join code", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "abc123" }]);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    const result = await store.disbandTeam("captain", "red-team");
    expect(result).toEqual({ ok: true, team: null });
    const [script, keys] = mocks.upstashEval.mock.calls[0];
    expect(keys).toEqual(["ctf:team:red-team", "ctf:team:red-team:members", "ctf:joincode:abc123"]);
    expect(script).toContain("SMEMBERS");
  });

  it("issues a new join code and clears the old one", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "old123" }]);
    mockCodeCollisionCheck(false);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    const result = await store.regenerateCode("captain", "red-team");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.team).toBe("red-team");
      expect(result.code).toMatch(/^[a-z0-9]{6}$/);
    }
    const [, keys, args] = mocks.upstashEval.mock.calls[0];
    expect(keys[0]).toBe("ctf:team:red-team");
    expect(keys[2]).toBe("ctf:joincode:old123");
    expect(args[0]).toBe("captain");
  });

  it("rejects every captain action when writes are disabled", async () => {
    const store = await loadStore(false);
    const denied = { ok: false, error: "Not available in demo mode" };
    expect(await store.removeMember("captain", "red-team", "member2")).toEqual(denied);
    expect(await store.renameTeam("captain", "red-team", "New Name")).toEqual(denied);
    expect(await store.transferCaptain("captain", "red-team", "member2")).toEqual(denied);
    expect(await store.disbandTeam("captain", "red-team")).toEqual(denied);
    expect(await store.regenerateCode("captain", "red-team")).toEqual(denied);
    expect(mocks.upstashEval).not.toHaveBeenCalled();
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("mock mode (TEAM_WRITES_ENABLED unset)", () => {
  it("persists to the per-browser cookie and never touches Upstash", async () => {
    const store = await loadStore(false);
    const result = await store.joinTeam("octocat", "Red Team");
    expect(result).toEqual({ ok: true, team: "red-team" });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
    expect(mocks.cookieJar.get("ctf-mock-team")).toBe("red-team");
  });

  it("reads the viewer's team back from the cookie", async () => {
    const store = await loadStore(false);
    mocks.cookieJar.set("ctf-mock-team", "red-team");
    expect(await store.getViewerTeam("octocat")).toEqual({
      slug: "red-team",
      name: "red-team",
      members: ["octocat"],
    });
  });

  it("leave clears the cookie", async () => {
    const store = await loadStore(false);
    mocks.cookieJar.set("ctf-mock-team", "red-team");
    expect(await store.leaveTeam("octocat")).toEqual({ ok: true, team: null });
    expect(mocks.cookieJar.has("ctf-mock-team")).toBe(false);
  });
});

// --- the configurable member cap (issue #99) --------------------------------
//
// ADR 31's lesson from the hint toggle is that a split-brain comes from
// surfaces reading a constant while the override lives elsewhere. The cap is
// enforced INSIDE the Lua join transaction, so what matters is the value that
// reaches the script — not what any UI says.

/** Queues the resolver's HGET of `teamMaxMembers`. */
function mockTeamCap(value: string | null) {
  mocks.upstashPipeline.mockResolvedValueOnce([{ result: value }]);
}

describe("team member cap", () => {
  it("hands the ORGANIZER'S override to the join script, not the default", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("red-team");
    mockTeamCap("6");
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.joinTeam("octocat", "somecode");
    const [, , argv] = mocks.upstashEval.mock.calls[0];
    expect(argv[1]).toBe(6);
  });

  it("falls back to the default when no override is stored", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("red-team");
    mockTeamCap(null);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.joinTeam("octocat", "somecode");
    const [, , argv] = mocks.upstashEval.mock.calls[0];
    expect(argv[1]).toBe(store.TEAM_MAX_MEMBERS);
  });

  it("quotes the RESOLVED cap when the team is full", async () => {
    // The message a contestant reads has to match the number that refused
    // them, or the support question writes itself.
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("red-team");
    mockTeamCap("2");
    mocks.upstashEval.mockResolvedValueOnce("full");
    const result = await store.joinTeam("octocat", "somecode");
    expect(result).toEqual({ ok: false, error: "Team is full (2 players max)" });
  });

  it("fails OPEN to the default when the store read throws", async () => {
    // Deliberately the opposite of the admin access check: a Redis blip must
    // not make every team look full and wedge registration. The Lua script
    // still enforces whatever value it is handed, atomically.
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("red-team");
    mocks.upstashPipeline.mockRejectedValueOnce(new Error("redis down"));
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.joinTeam("octocat", "somecode");
    const [, , argv] = mocks.upstashEval.mock.calls[0];
    expect(argv[1]).toBe(store.TEAM_MAX_MEMBERS);
  });

  it("ignores a junk or out-of-range stored value", async () => {
    const store = await loadStore(true);
    for (const junk of ["0", "-3", "abc", ""]) {
      vi.clearAllMocks();
      mockRegistrationOpen();
      mockCodeLookup("red-team");
      mockTeamCap(junk);
      mocks.upstashEval.mockResolvedValueOnce("ok");
      await store.joinTeam("octocat", "somecode");
      const [, , argv] = mocks.upstashEval.mock.calls[0];
      expect(argv[1]).toBe(store.TEAM_MAX_MEMBERS);
    }
  });

  it("never evicts: lowering the cap leaves an over-sized team intact", async () => {
    // The cap is a JOIN guard. The script only ever SADDs after an SCARD
    // check, so there is no path here that removes a member — this pins that
    // the join flow does not grow one.
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("red-team");
    mockTeamCap("2");
    mocks.upstashEval.mockResolvedValueOnce("full");
    await store.joinTeam("octocat", "somecode");
    const [script] = mocks.upstashEval.mock.calls[0];
    expect(script).not.toContain("SREM");
    expect(script).toContain("SCARD");
  });
});

// --- shareable join links (issue #45) ---------------------------------------

describe("lookupJoinCode", () => {
  it("resolves a code to its team for display", async () => {
    const store = await loadStore(true);
    mockCodeLookup("red-team");
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "Red Team" }, { result: 2 }]);
    expect(await store.lookupJoinCode("ABC123")).toEqual({ slug: "red-team", name: "Red Team", memberCount: 2 });
  });

  it("normalizes the code the same way joinTeam does", async () => {
    // A captain pastes the code in caps, or the link carries whitespace. If
    // the preview and the join disagreed on normalization, the page would show
    // a team and the button would then say "invalid code".
    const store = await loadStore(true);
    mockCodeLookup("red-team");
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "Red Team" }, { result: 1 }]);
    await store.lookupJoinCode("  AbC123  ");
    const [firstCall] = mocks.upstashPipeline.mock.calls;
    expect(firstCall[0]).toEqual([["GET", "ctf:joincode:abc123"]]);
  });

  it("returns null for an unknown code", async () => {
    const store = await loadStore(true);
    mockCodeLookup(null);
    expect(await store.lookupJoinCode("nope")).toBeNull();
  });

  it("returns null for an empty code without touching the store", async () => {
    const store = await loadStore(true);
    expect(await store.lookupJoinCode("   ")).toBeNull();
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("treats a code whose team is gone as expired, not as an empty team", async () => {
    // leaveTeam deletes the team key and its code together, but a partially
    // cleaned state must not render a card for a team that no longer exists.
    const store = await loadStore(true);
    mockCodeLookup("ghost-team");
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }, { result: 0 }]);
    expect(await store.lookupJoinCode("ABC123")).toBeNull();
  });

  it("resolves nothing when team writes are disabled", async () => {
    const store = await loadStore(false);
    expect(await store.lookupJoinCode("ABC123")).toBeNull();
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("NEVER joins — it only reads", async () => {
    // The whole point of splitting lookup from join: a GET on the invite page
    // must not add anyone to a team, or a link preview would.
    const store = await loadStore(true);
    mockCodeLookup("red-team");
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "Red Team" }, { result: 1 }]);
    await store.lookupJoinCode("ABC123");
    expect(mocks.upstashEval).not.toHaveBeenCalled();
    for (const [cmds] of mocks.upstashPipeline.mock.calls) {
      for (const cmd of cmds as string[][]) {
        expect(["GET", "HGET", "SCARD"]).toContain(cmd[0]);
      }
    }
  });
});

// --- the team requirement (issue #153) ---------------------------------------
//
// Scoring is per team: `foldTeamTotals` builds a team's total from its
// MEMBERS' earned items, so points banked by a login on no team fold into
// nothing. `hasTeam` is the gate every scoring route asks before banking.

describe("hasTeam", () => {
  it("is true for a login on a team", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "red-team" }]);
    expect(await store.hasTeam("octocat")).toBe(true);
  });

  it("is false for a login on no team", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    expect(await store.hasTeam("octocat")).toBe(false);
  });

  it("treats an empty-string team as no team, not as a team named \"\"", async () => {
    const store = await loadStore(true);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "" }]);
    expect(await store.hasTeam("octocat")).toBe(false);
  });

  it("fails OPEN when the store is unreachable", async () => {
    // Deliberately the opposite of `requireAdmin`. A Redis blip must not drop
    // live submissions: being briefly wrong about membership costs one
    // unattributed score, while failing closed costs every contestant every
    // point they earn for the length of the outage.
    const store = await loadStore(true);
    mocks.upstashPipeline.mockRejectedValueOnce(new Error("redis down"));
    expect(await store.hasTeam("octocat")).toBe(true);
  });

  it("is true in mock mode without asking the store at all", async () => {
    // With TEAM_WRITES_ENABLED unset there is no team system to be on the
    // wrong side of, so enforcing would lock every demo out of scoring to
    // protect an invariant that build cannot hold.
    const store = await loadStore(false);
    expect(await store.hasTeam("octocat")).toBe(true);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("createSoloTeam", () => {
  it("names the team after the contestant, with them as captain", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeCollisionCheck(false);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    expect(await store.createSoloTeam("octocat")).toEqual({ ok: true, team: "octocat" });
    const [, keys, args] = mocks.upstashEval.mock.calls[0];
    expect(keys[1]).toBe("ctf:team:octocat");
    expect(args[0]).toBe("octocat");
  });

  it("falls back to a suffixed name when that team name is already taken", async () => {
    // Team names are their own namespace, so nothing stops someone else from
    // having created a team called "octocat". The whole promise of this path
    // is one click, so a collision retries rather than erroring.
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeCollisionCheck(false);
    mocks.upstashEval.mockResolvedValueOnce("name-taken");
    mockCodeCollisionCheck(false);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    const result = await store.createSoloTeam("octocat");
    expect(result.ok).toBe(true);
    expect(result.ok && result.team).toMatch(/^octocat-[a-z2-9]{3}$/);
  });

  it("gives up and asks for a name rather than retrying forever", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    // EXACTLY the attempt budget. Queueing spares would leave unconsumed
    // `mockResolvedValueOnce` entries behind — `vi.clearAllMocks()` clears
    // recorded calls but NOT the queued one-shot implementations, so the
    // leftovers would surface in the next test as a phantom reply.
    for (let i = 0; i < 4; i++) {
      mockCodeCollisionCheck(false);
      mocks.upstashEval.mockResolvedValueOnce("name-taken");
    }
    expect(await store.createSoloTeam("octocat")).toEqual({
      ok: false,
      error: "Couldn't create a team for you. Pick a team name instead",
    });
  });

  it("clamps a long login to the team-name cap", async () => {
    // A GitHub login runs to 39 characters and a team name stops at 32, so a
    // login is NOT automatically a legal team name — unclamped, this path
    // would mint names `renameTeam` then refuses.
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeCollisionCheck(false);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    const result = await store.createSoloTeam("a".repeat(39));
    expect(result.ok).toBe(true);
    expect(result.ok && result.team).toEqual(expect.stringMatching(/^a{1,32}$/));
  });

  it("refuses while registration is closed, like every other create path", async () => {
    const store = await loadStore(true);
    mockRegistrationClosed();
    const result = await store.createSoloTeam("octocat");
    expect(result.ok).toBe(false);
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("refuses a contestant who is already on a team", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeCollisionCheck(false);
    mocks.upstashEval.mockResolvedValueOnce("already-on-team");
    expect(await store.createSoloTeam("octocat")).toEqual({
      ok: false,
      error: "Leave your current team before creating one",
    });
  });
});

// --- membership timestamps (issue #169's funnel) -----------------------------
//
// `joinedAt` is a fact about the CURRENT team and dies with it. `firstTeamAt`
// is the funnel's conversion moment — the first time this login was ever on a
// team — and must survive leaving, being removed, and switching teams. Getting
// these the same way round would silently report every team-switcher as having
// converted later than they did.

describe("joinedAt / firstTeamAt", () => {
  it("stamps both when a contestant creates their first team", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeCollisionCheck(false);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.createTeam("octocat", "Red Team");
    const [script] = mocks.upstashEval.mock.calls[0];
    expect(script).toContain("'joinedAt'");
    expect(script).toContain("'firstTeamAt'");
  });

  it("stamps both when a contestant joins by code", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("red-team");
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.joinTeam("octocat", "somecode");
    const [script, , args] = mocks.upstashEval.mock.calls[0];
    expect(script).toContain("'joinedAt'");
    expect(script).toContain("'firstTeamAt'");
    // The timestamp is an argument, not something the script invents — Lua's
    // clock is not the app's, and a script that called TIME would also stop
    // being deterministic to replay.
    expect(String(args[3])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("writes firstTeamAt with HSETNX so a SECOND join never moves it", async () => {
    // The whole point. HSET would overwrite, and every contestant who switched
    // teams would report a later conversion than actually happened.
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("red-team");
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.joinTeam("octocat", "somecode");
    const [script] = mocks.upstashEval.mock.calls[0];
    expect(script).toMatch(/HSETNX'?,\s*KEYS\[1\],\s*'firstTeamAt'/);
    // ...and it is NOT also written by the plain HSET beside it.
    const hset = script.split("\n").find((l) => l.includes("'team'")) ?? "";
    expect(hset).not.toContain("firstTeamAt");
  });

  it("clears joinedAt — and NOT firstTeamAt — when leaving", async () => {
    const store = await loadStore(true);
    // leaveTeam resolves the current slug first; without this it returns
    // early and never reaches the script this test is about.
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "red-team" }]);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.leaveTeam("octocat");
    const [script] = mocks.upstashEval.mock.calls[0];
    expect(script).toContain("'team', 'joinedAt'");
    expect(script).not.toContain("HDEL', KEYS[1], 'firstTeamAt'");
    expect(script).not.toMatch(/HDEL[^\n]*firstTeamAt/);
  });

  it("clears joinedAt — and NOT firstTeamAt — when a captain removes someone", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.removeMember("captain", "red-team", "octocat");
    const [script] = mocks.upstashEval.mock.calls[0];
    expect(script).toContain("'team', 'joinedAt'");
    expect(script).not.toMatch(/HDEL[^\n]*firstTeamAt/);
  });

  it("clears joinedAt — and NOT firstTeamAt — for every member on disband", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.disbandTeam("captain", "red-team");
    const [script] = mocks.upstashEval.mock.calls[0];
    expect(script).toContain("'team', 'joinedAt'");
    expect(script).not.toMatch(/HDEL[^\n]*firstTeamAt/);
  });

  it("never deletes firstTeamAt from ANY team script", async () => {
    // One assertion over the whole surface, so a script added later cannot
    // quietly become the path that erases the funnel record.
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeCollisionCheck(false);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.createTeam("octocat", "Red Team");
    mockRegistrationOpen();
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.transferCaptain("captain", "red-team", "bob");
    for (const [script] of mocks.upstashEval.mock.calls) {
      expect(script).not.toMatch(/HDEL[^\n]*firstTeamAt/);
      expect(script).not.toMatch(/'DEL'[^\n]*firstTeamAt/);
    }
  });
});

// Issue #212: every successful membership mutation writes one activity-log
// entry (type + acting login + team slug — the slug, never anything richer),
// and NO refusal path does. logActivity itself is fail-open (pinned in
// activity-log.test.ts); these pin only that the store calls it at the right
// moments.
describe("activity log", () => {
  it("logs team-create with the slug on a successful create", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeCollisionCheck(false);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.createTeam("octocat", "Red Team");
    expect(mocks.logActivity).toHaveBeenCalledExactlyOnceWith("team-create", "octocat", "red-team");
  });

  it("logs team-join on a successful join, team-leave on a successful leave", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeLookup("red-team");
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.joinTeam("octocat", "somecode");
    expect(mocks.logActivity).toHaveBeenCalledWith("team-join", "octocat", "red-team");

    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "red-team" }]);
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.leaveTeam("octocat");
    expect(mocks.logActivity).toHaveBeenCalledWith("team-leave", "octocat", "red-team");
  });

  it("logs team-rename against the captain, keyed by the unchanged slug", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mocks.upstashEval.mockResolvedValueOnce("ok");
    await store.renameTeam("captain", "red-team", "Crimson Team");
    expect(mocks.logActivity).toHaveBeenCalledExactlyOnceWith("team-rename", "captain", "red-team");
  });

  it("logs nothing on a refusal", async () => {
    const store = await loadStore(true);
    mockRegistrationOpen();
    mockCodeCollisionCheck(false);
    mocks.upstashEval.mockResolvedValueOnce("already-on-team");
    await store.createTeam("octocat", "Red Team");

    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "red-team" }]);
    mocks.upstashEval.mockResolvedValueOnce("captain-must-transfer");
    await store.leaveTeam("captain");

    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("logs nothing in mock (cookie) mode — a browser-local choice is not an event fact", async () => {
    const store = await loadStore(false);
    await store.createTeam("octocat", "Red Team");
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });
});
