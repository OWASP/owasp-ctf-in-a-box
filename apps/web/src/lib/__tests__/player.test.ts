import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { upstash, getSession } = vi.hoisted(() => ({
  upstash: { upstashPipeline: vi.fn() },
  getSession: vi.fn(),
}));
// The real SCAN-page parser: findPlayers' HSCAN replies go through it.
vi.mock("@/lib/upstash", async (importOriginal) => ({
  parseScanPage: (await importOriginal<typeof import("@/lib/upstash")>()).parseScanPage,
  upstashPipeline: upstash.upstashPipeline,
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));

import { PLAYER_ID_RE, displayNameOf, findPlayers, getPlayer, getPlayerProfiles } from "@/lib/player";

const ID = "3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b";

beforeEach(() => {
  upstash.upstashPipeline.mockReset();
  getSession.mockReset();
});

describe("PLAYER_ID_RE", () => {
  it("accepts a randomUUID", () => {
    expect(PLAYER_ID_RE.test(crypto.randomUUID())).toBe(true);
  });
  it("rejects a login, a better-auth default id, and anything with a colon", () => {
    expect(PLAYER_ID_RE.test("OctoCat")).toBe(false);
    expect(PLAYER_ID_RE.test("aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG")).toBe(false);
    expect(PLAYER_ID_RE.test(`${ID}:x`)).toBe(false);
    expect(PLAYER_ID_RE.test(ID.toUpperCase())).toBe(false);
  });
});

describe("displayNameOf", () => {
  it("prefers username, then login, then name, then the id fallback", () => {
    expect(displayNameOf({ id: ID, username: "u", login: "l", name: "n" })).toBe("u");
    expect(displayNameOf({ id: ID, username: null, login: "l", name: "n" })).toBe("l");
    expect(displayNameOf({ id: ID, login: "", name: "n" })).toBe("n");
    expect(displayNameOf({ id: ID })).toBe("player 3f2b8c1e");
  });
});

describe("getPlayer", () => {
  it("is null with no session", async () => {
    getSession.mockResolvedValue(null);
    expect(await getPlayer(new Headers())).toBeNull();
  });
  it("is null when the session user id is not a player id", async () => {
    getSession.mockResolvedValue({ user: { id: "AbC123", login: "x" } });
    expect(await getPlayer(new Headers())).toBeNull();
  });
  it("maps the session user", async () => {
    getSession.mockResolvedValue({ user: { id: ID, login: "octo", name: "Octo", image: "http://i" } });
    expect(await getPlayer(new Headers())).toEqual({ id: ID, name: "octo", image: "http://i", githubLogin: "octo" });
  });
});

describe("getPlayerProfiles", () => {
  it("makes no Redis call for no ids", async () => {
    expect((await getPlayerProfiles([])).size).toBe(0);
    expect(upstash.upstashPipeline).not.toHaveBeenCalled();
  });
  it("issues one HMGET and decodes rows, skipping missing ones", async () => {
    upstash.upstashPipeline.mockResolvedValue([
      { result: [JSON.stringify({ id: "a", login: "octo", image: null }), null] },
    ]);
    const map = await getPlayerProfiles(["a", "b"]);
    expect(upstash.upstashPipeline).toHaveBeenCalledTimes(1);
    expect(upstash.upstashPipeline).toHaveBeenCalledWith([["HMGET", "ctf:auth:user", "a", "b"]]);
    expect(map.get("a")).toEqual({ id: "a", name: "octo", image: null, githubLogin: "octo" });
    expect(map.has("b")).toBe(false);
  });
  it("throws when the command carries an error", async () => {
    upstash.upstashPipeline.mockResolvedValue([{ error: "WRONGTYPE" }]);
    await expect(getPlayerProfiles(["a"])).rejects.toThrow(/WRONGTYPE/);
  });
});

describe("findPlayers", () => {
  const row = (id: string, parts: Record<string, unknown>) => [id, JSON.stringify({ id, image: null, ...parts })];
  const A = "3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a51";
  const B = "3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a52";
  const C = "3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a53";

  it("matches the GitHub login case-insensitively, and the display name", async () => {
    upstash.upstashPipeline.mockResolvedValueOnce([
      { result: ["0", [...row(A, { login: "OctoCat" }), ...row(B, { login: "hubot", username: "Octavia" }), ...row(C, { login: "mona" })]] },
    ]);
    const found = await findPlayers("oct");
    expect(found.map((p) => p.id)).toEqual([A, B]);
    expect(found[0]).toEqual({ id: A, name: "OctoCat", image: null, githubLogin: "OctoCat" });
    expect(upstash.upstashPipeline).toHaveBeenCalledWith([["HSCAN", "ctf:auth:user", "0", "COUNT", 200]]);
  });

  it("caps at limit and stops scanning once it has enough", async () => {
    upstash.upstashPipeline.mockResolvedValueOnce([
      { result: ["17", [...row(A, { login: "octo-a" }), ...row(B, { login: "octo-b" })]] },
    ]);
    const found = await findPlayers("OCTO", 1);
    expect(found.map((p) => p.id)).toEqual([A]);
    expect(upstash.upstashPipeline).toHaveBeenCalledTimes(1);
  });

  it("follows the cursor until the hash is walked", async () => {
    upstash.upstashPipeline
      .mockResolvedValueOnce([{ result: ["9", row(A, { login: "mona" })] }])
      .mockResolvedValueOnce([{ result: ["0", row(B, { login: "octo" })] }]);
    expect((await findPlayers("octo")).map((p) => p.id)).toEqual([B]);
    expect(upstash.upstashPipeline).toHaveBeenLastCalledWith([["HSCAN", "ctf:auth:user", "9", "COUNT", 200]]);
  });

  it("matches nothing for a blank query, without a Redis call", async () => {
    expect(await findPlayers("   ")).toEqual([]);
    expect(upstash.upstashPipeline).not.toHaveBeenCalled();
  });

  it("throws when the HSCAN carries an error", async () => {
    upstash.upstashPipeline.mockResolvedValueOnce([{ error: "WRONGTYPE" }]);
    await expect(findPlayers("octo")).rejects.toThrow(/WRONGTYPE/);
  });
});
