// The activity log's two contracts (issue #212), pinned:
//
//   1. The writer FAILS OPEN. logActivity sits inside sign-in, flag
//      submission and team mutations — a Redis failure must lose the log
//      line, never the action. A test that only checks the happy path would
//      let a rethrow slip in and turn every login into a 500 on the next
//      Redis blip.
//
//   2. Every write carries its own LTRIM, in the SAME pipeline as the LPUSH,
//      so the list is bounded by construction — no separate janitor whose
//      absence lets it grow forever.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_LOG_KEY, ACTIVITY_LOG_MAX } from "@/lib/activity-keys";
import { decoratedError, expectLabelOnly } from "./log-redaction";

vi.mock("server-only", () => ({}));

const upstash = vi.hoisted(() => ({ upstashPipeline: vi.fn() }));
vi.mock("@/lib/upstash", () => upstash);

const ID = "0b9e4f3c-1d2a-4c5b-8e6f-7a8b9c0d1e2f";
const OTHER = "1c0f5a4d-2e3b-4d6c-9f70-8b9cad0e1f30";
const players = vi.hoisted(() => ({ getPlayerProfiles: vi.fn() }));
vi.mock("@/lib/player", async () => {
  const PLAYER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const displayNameOf = (r: { id: string; username?: string | null; login?: string | null; name?: string | null }) =>
    r.username || r.login || r.name || `player ${r.id.slice(0, 8)}`;
  return { PLAYER_ID_RE, displayNameOf, getPlayerProfiles: players.getPlayerProfiles };
});

import { listActivity, logActivity, recordCallbackLogin } from "@/lib/activity-log";

beforeEach(() => {
  upstash.upstashPipeline.mockReset();
  upstash.upstashPipeline.mockResolvedValue([{ result: 1 }, { result: "OK" }]);
  players.getPlayerProfiles.mockReset();
  players.getPlayerProfiles.mockResolvedValue(new Map([[ID, { id: ID, name: "octocat", image: null, githubLogin: "octocat" }]]));
});

describe("logActivity", () => {
  it("LPUSHes the entry and trims to the cap in one pipeline", async () => {
    await logActivity("login", ID);
    expect(upstash.upstashPipeline).toHaveBeenCalledTimes(1);
    const commands = upstash.upstashPipeline.mock.calls[0][0] as (string | number)[][];
    expect(commands).toHaveLength(2);
    expect(commands[0].slice(0, 2)).toEqual(["LPUSH", ACTIVITY_LOG_KEY]);
    expect(commands[1]).toEqual(["LTRIM", ACTIVITY_LOG_KEY, 0, ACTIVITY_LOG_MAX - 1]);
  });

  it("writes at/type/userId/name, with detail present only when given", async () => {
    await logActivity("classic-solve", ID, "crypto-1");
    const withDetail = JSON.parse(String((upstash.upstashPipeline.mock.calls[0][0] as string[][])[0][2]));
    expect(withDetail).toEqual({
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      type: "classic-solve",
      userId: ID,
      name: "octocat",
      detail: "crypto-1",
    });

    await logActivity("login", ID);
    const bare = JSON.parse(String((upstash.upstashPipeline.mock.calls[1][0] as string[][])[0][2]));
    expect(Object.keys(bare).sort()).toEqual(["at", "name", "type", "userId"]);
  });

  it("takes a name it is handed without a profile lookup", async () => {
    await logActivity("team-join", { id: ID, name: "Mona" }, "red-team");
    expect(players.getPlayerProfiles).not.toHaveBeenCalled();
    const entry = JSON.parse(String((upstash.upstashPipeline.mock.calls[0][0] as string[][])[0][2]));
    expect(entry).toMatchObject({ userId: ID, name: "Mona" });
  });

  // A player with no account row (deleted, demo data) still gets a line,
  // under the short-id name; so does one whose lookup failed.
  it("falls back to the short-id name when the profile is missing or the lookup fails", async () => {
    await logActivity("login", OTHER);
    players.getPlayerProfiles.mockRejectedValue(new Error("redis down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await logActivity("login", OTHER);
    } finally {
      warn.mockRestore();
    }
    const names = upstash.upstashPipeline.mock.calls.map((c) => JSON.parse(String((c[0] as string[][])[0][2])).name);
    expect(names).toEqual(["player 1c0f5a4d", "player 1c0f5a4d"]);
  });

  // THE fail-open pin. A rejected pipeline resolves quietly; the caller's
  // login/solve/team write is already durable and must stay that way.
  it("swallows a Redis failure instead of throwing", async () => {
    upstash.upstashPipeline.mockRejectedValue(new Error("redis down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(logActivity("login", ID)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // The write carries the entry (player, type, detail) as ARGV, so a
  // driver-decorated rejection would put it in the log. Label only (#500).
  it("logs the label, not the rejected error", async () => {
    upstash.upstashPipeline.mockRejectedValue(decoratedError("redis down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(logActivity("login", ID)).resolves.toBeUndefined();
      expectLabelOnly(warn, { label: "redis down" });
    } finally {
      warn.mockRestore();
    }
  });

  // Fail-open covers HANGS, not just rejections: this writer sits inside
  // sign-in callbacks and submit routes, and upstashPipeline's fetch has no
  // timeout of its own — a stalled Upstash request must not keep a login or
  // a solve pending past LOG_WRITE_TIMEOUT_MS.
  it("stops waiting on a hung write after the timeout", async () => {
    vi.useFakeTimers();
    try {
      upstash.upstashPipeline.mockReturnValue(new Promise(() => {})); // never settles
      let resolved = false;
      const pending = logActivity("login", ID).then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(1499);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await pending;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("recordCallbackLogin", () => {
  const session = { user: { id: ID, login: "octocat", name: "The Octocat" } };

  it("logs a login for the OAuth callback path, template or literal", async () => {
    await recordCallbackLogin("/callback/:id", session);
    await recordCallbackLogin("/callback/github", session);
    expect(upstash.upstashPipeline).toHaveBeenCalledTimes(2);
    const entry = JSON.parse(String((upstash.upstashPipeline.mock.calls[0][0] as string[][])[0][2]));
    expect(entry.type).toBe("login");
    expect(entry.userId).toBe(ID);
    expect(entry.name).toBe("octocat");
    expect(players.getPlayerProfiles).not.toHaveBeenCalled();
  });

  // A fresh session on any OTHER path (a /get-session cookie refresh, a
  // sign-out) is not a sign-in. Logging those would turn every page load
  // into a "login" row and drown the log.
  it("ignores every non-callback path, session or not", async () => {
    await recordCallbackLogin("/get-session", session);
    await recordCallbackLogin("/sign-out", session);
    expect(upstash.upstashPipeline).not.toHaveBeenCalled();
  });

  it("ignores a callback with no session or no player id", async () => {
    await recordCallbackLogin("/callback/:id", null);
    await recordCallbackLogin("/callback/:id", { user: {} });
    await recordCallbackLogin("/callback/:id", { user: { id: 42 } });
    await recordCallbackLogin("/callback/:id", { user: { id: "octocat", login: "octocat" } });
    expect(upstash.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("listActivity", () => {
  const row = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ at: "2026-08-24T18:00:00.000Z", type: "login", userId: ID, name: "octocat", ...over });

  it("reads one LRANGE page plus the LLEN total", async () => {
    upstash.upstashPipeline.mockResolvedValue([{ result: [row()] }, { result: 42 }]);
    const page = await listActivity(10, 5);
    expect(upstash.upstashPipeline).toHaveBeenCalledWith([
      ["LRANGE", ACTIVITY_LOG_KEY, 10, 14],
      ["LLEN", ACTIVITY_LOG_KEY],
    ]);
    expect(page.total).toBe(42);
    expect(page.entries).toEqual([{ at: "2026-08-24T18:00:00.000Z", type: "login", userId: ID, name: "octocat" }]);
  });

  // One corrupt row must not blank the whole tab — and a type this build
  // doesn't know (written by a newer or older deploy) is DATA, not
  // corruption, so it comes through.
  it("skips malformed rows and keeps unknown types", async () => {
    upstash.upstashPipeline.mockResolvedValue([
      { result: ["not json", JSON.stringify({ type: "login" }), row({ type: "future-thing", detail: "x" }), row()] },
      { result: 4 },
    ]);
    const page = await listActivity(0, 10);
    expect(page.entries.map((e) => e.type)).toEqual(["future-thing", "login"]);
    expect(page.entries[0].detail).toBe("x");
  });

  // Unlike the writer, the reader THROWS: it has nothing useful to degrade
  // to, and the route maps the throw to a 503.
  it("throws when Redis reports an error", async () => {
    upstash.upstashPipeline.mockResolvedValue([{ error: "WRONGTYPE" }, { result: 0 }]);
    await expect(listActivity(0, 10)).rejects.toThrow("WRONGTYPE");
  });
});
