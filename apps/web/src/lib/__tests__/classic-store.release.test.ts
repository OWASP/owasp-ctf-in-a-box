// A scheduled release rides on the stored record: `releaseAt` (the ISO
// instant) and `releaseAtMs`, its epoch-ms mirror for the grading and hint
// scripts, which compare it to Redis's clock and cannot parse ISO in Lua.
// Every write goes through one canonical form, so the mirror cannot go
// missing on a re-serialization (a rename, an import).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upstashEval: vi.fn(), upstashPipeline: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval: mocks.upstashEval, upstashPipeline: mocks.upstashPipeline }));
vi.mock("@/lib/attachments-store", () => ({
  deleteItemAttachments: vi.fn(),
  clearAllAttachments: vi.fn(),
  listAllAttachments: vi.fn(async () => new Map()),
  listAttachments: vi.fn(async () => []),
  addLink: vi.fn(),
  addMissingUpload: vi.fn(),
}));

import { ClassicValidationError, exportBundle, importBundle, listChallenges, renameCategory, upsertChallenge, type Challenge } from "@/lib/classic-store";

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

const challenge = (over: Partial<Challenge> = {}): Challenge => ({
  id: "chal-1",
  title: "A challenge",
  category: "Web",
  description: "",
  points: 50,
  order: 1,
  ...over,
});
const row = (c: Record<string, unknown>) => [c.id as string, JSON.stringify(c)];
const pipelineCalls = (): (string | number)[][][] => mocks.upstashPipeline.mock.calls.map((call) => call[0] as (string | number)[][]);
const storedRecord = (id: string): Record<string, unknown> => {
  const cmd = pipelineCalls()
    .flat()
    .filter((c) => c[0] === "HSET" && c[1] === "ctf:classic:challenges" && c[2] === id)
    .at(-1);
  if (!cmd) throw new Error(`no record written for ${id}`);
  return JSON.parse(String(cmd[3])) as Record<string, unknown>;
};

beforeEach(() => {
  mocks.upstashPipeline.mockReset();
  mocks.upstashPipeline.mockResolvedValue([{ result: [] }, { result: [] }, { result: [] }, { result: [] }]);
});

describe("saving a release time", () => {
  it("stores a future release as hidden until then, with the epoch-ms mirror the scripts compare", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    const saved = await upsertChallenge(challenge({ releaseAt: FUTURE }), "CTF{a}");
    expect(storedRecord("chal-1")).toMatchObject({ enabled: false, releaseAt: FUTURE, releaseAtMs: Date.parse(FUTURE) });
    // The mirror is storage plumbing: never part of the returned record.
    expect(saved.challenge).toEqual(challenge({ enabled: false, releaseAt: FUTURE }));
  });

  it("stores a release time that has already passed as plain live", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    await upsertChallenge(challenge({ enabled: false, releaseAt: PAST }), "CTF{a}");
    const record = storedRecord("chal-1");
    expect("enabled" in record || "releaseAt" in record || "releaseAtMs" in record).toBe(false);
  });

  it("normalizes the instant to UTC ISO", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    const local = "2099-10-08T10:00:00-03:00";
    await upsertChallenge(challenge({ releaseAt: local }), "CTF{a}");
    expect(storedRecord("chal-1").releaseAt).toBe("2099-10-08T13:00:00.000Z");
  });

  it("refuses an unreadable release time before writing anything", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    await expect(upsertChallenge(challenge({ releaseAt: "tomorrow" }), "CTF{a}")).rejects.toBeInstanceOf(ClassicValidationError);
    expect(pipelineCalls().flat().some((c) => c[0] === "HSET")).toBe(false);
  });
});

describe("reading and re-writing it", () => {
  it("reads releaseAt back, but not the mirror", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: row({ ...challenge({ enabled: false, releaseAt: FUTURE }), releaseAtMs: Date.parse(FUTURE) }) },
    ]);
    const [c] = await listChallenges();
    expect(c.releaseAt).toBe(FUTURE);
    expect("releaseAtMs" in c).toBe(false);
  });

  it("a category rename keeps the schedule AND its mirror, or the grader would never release it", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Webb"]) }]);
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: row({ ...challenge({ category: "Webb", enabled: false, releaseAt: FUTURE }), releaseAtMs: Date.parse(FUTURE) }) },
    ]);
    await renameCategory("Webb", "Web");
    expect(storedRecord("chal-1")).toMatchObject({ category: "Web", enabled: false, releaseAt: FUTURE, releaseAtMs: Date.parse(FUTURE) });
  });

  it("an import writes the schedule with its mirror", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: [] }, { result: null }]);
    await importBundle({
      version: 4,
      categories: ["Web"],
      challenges: [{ id: "s", title: "S", category: "Web", description: "", points: 1, order: 0, flag: "f", releaseAt: FUTURE }],
    });
    expect(storedRecord("s")).toMatchObject({ enabled: false, releaseAt: FUTURE, releaseAtMs: Date.parse(FUTURE) });
  });

  it("exports the release time at version 4", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: row({ ...challenge({ enabled: false, releaseAt: FUTURE }), releaseAtMs: Date.parse(FUTURE) }) },
      { result: ["chal-1", "CTF{x}"] },
      { result: [] },
    ]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
    const bundle = await exportBundle();
    expect(bundle.version).toBe(4);
    expect(bundle.challenges[0]).toMatchObject({ enabled: false, releaseAt: FUTURE });
    expect("releaseAtMs" in bundle.challenges[0]).toBe(false);
  });
});

describe("a release time's zone", () => {
  it("refuses an offset-less or impossible instant before writing anything", async () => {
    for (const releaseAt of ["2099-10-08T10:00:00", "2099-02-30T10:00:00Z", "2099-10-08T25:00:00Z"]) {
      mocks.upstashPipeline.mockReset();
      mocks.upstashPipeline.mockResolvedValue([{ result: JSON.stringify(["Web"]) }]);
      await expect(upsertChallenge(challenge({ releaseAt }), "CTF{a}")).rejects.toBeInstanceOf(ClassicValidationError);
      expect(pipelineCalls().flat().some((c) => c[0] === "HSET")).toBe(false);
    }
  });

  it("accepts Z and an explicit offset", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    await upsertChallenge(challenge({ releaseAt: "2099-10-08T13:00:00Z" }), "CTF{a}");
    expect(storedRecord("chal-1").releaseAt).toBe("2099-10-08T13:00:00.000Z");
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    await upsertChallenge(challenge({ releaseAt: "2099-10-08T15:00:00+02:00" }), "CTF{a}");
    expect(storedRecord("chal-1").releaseAt).toBe("2099-10-08T13:00:00.000Z");
  });
});
