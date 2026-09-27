// Stories (#463): stored like categories — one JSON list — and validated so a
// challenge sits in at most one story, once.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upstashPipeline: vi.fn(), upstashEval: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval: mocks.upstashEval, upstashPipeline: mocks.upstashPipeline }));
vi.mock("@/lib/attachments-store", () => ({ deleteItemAttachments: vi.fn(), clearAllAttachments: vi.fn() }));

import { deleteChallenge, listStories, setStories } from "@/lib/classic-store";
import { CLASSIC_STORIES_KEY } from "@/lib/classic-keys";

const story = (id: string, steps: string[]) => ({ id, title: `T ${id}`, intro: "", steps });

beforeEach(() => {
  mocks.upstashPipeline.mockReset();
  mocks.upstashPipeline.mockResolvedValue([{ result: "OK" }]);
});

describe("listStories", () => {
  it("reads an absent key as no stories", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    expect(await listStories()).toEqual([]);
  });

  it("returns the stored list", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify([story("op", ["a", "b"])]) }]);
    expect(await listStories()).toEqual([story("op", ["a", "b"])]);
  });

  it("THROWS on a read error or a corrupt value — never guesses 'no stories' (that would open every step)", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH" }]);
    await expect(listStories()).rejects.toThrow();
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: "{not json" }]);
    await expect(listStories()).rejects.toThrow();
  });
});

describe("setStories", () => {
  it("stores a valid list", async () => {
    const stored = await setStories([story("op", ["a", "b"]), story("side", ["c"])]);
    expect(stored).toHaveLength(2);
    const [[cmd]] = mocks.upstashPipeline.mock.calls.at(-1)!;
    expect(cmd).toEqual(["SET", CLASSIC_STORIES_KEY, JSON.stringify(stored)]);
  });

  it("refuses a challenge in two stories, a repeated step, duplicate story ids, and empty ids or titles", async () => {
    await expect(setStories([story("op", ["a"]), story("side", ["a"])])).rejects.toThrow(/one story/);
    await expect(setStories([story("op", ["a", "a"])])).rejects.toThrow(/twice/);
    await expect(setStories([story("op", ["a"]), story("op", ["b"])])).rejects.toThrow(/unique/);
    await expect(setStories([{ id: "", title: "x", intro: "", steps: ["a"] }])).rejects.toThrow();
    await expect(setStories([{ id: "op", title: " ", intro: "", steps: ["a"] }])).rejects.toThrow();
  });
});

describe("deleteChallenge and stories", () => {
  it("removes a deleted challenge from its story (the story shrinks)", async () => {
    mocks.upstashPipeline
      .mockResolvedValueOnce([{ result: 1 }, { result: 1 }, { result: 1 }, { result: 1 }]) // the HDELs
      .mockResolvedValueOnce([{ result: JSON.stringify([story("op", ["recon-ab12cd", "web-cd34ef"])]) }]) // read
      .mockResolvedValueOnce([{ result: "OK" }]); // write back
    await deleteChallenge("recon-ab12cd");
    const [[cmd]] = mocks.upstashPipeline.mock.calls.at(-1)!;
    expect(cmd[0]).toBe("SET");
    expect(JSON.parse(cmd[2])).toEqual([story("op", ["web-cd34ef"])]);
  });
});
