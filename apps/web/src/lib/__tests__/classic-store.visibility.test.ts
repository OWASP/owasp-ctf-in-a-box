// A Jeopardy challenge's visibility rides on its stored record: `enabled`
// (absent = live). These pin the store's half — the field is written only
// when it says something, read back exactly, carried through every write
// that re-serializes a record, and exported so a backup restores it. What
// the readers do with it is pinned next to each reader.

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

import {
  exportBundle,
  importBundle,
  listChallenges,
  listChallengesForAdmin,
  readChallengeRecords,
  renameCategory,
  upsertChallenge,
  type Challenge,
} from "@/lib/classic-store";
import { parseBundle } from "@/lib/classic-io";

const challenge = (over: Partial<Challenge> = {}): Challenge => ({
  id: "chal-1",
  title: "A challenge",
  category: "Web",
  description: "Find the flag.",
  points: 50,
  order: 1,
  ...over,
});
const row = (c: Record<string, unknown>) => [c.id as string, JSON.stringify(c)];

const pipelineCalls = (): (string | number)[][][] =>
  mocks.upstashPipeline.mock.calls.map((call) => call[0] as (string | number)[][]);
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

describe("reading the visibility field back", () => {
  it("carries enabled:false off the stored record, and leaves an absent field absent", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: [...row(challenge({ id: "off", enabled: false })), ...row(challenge({ id: "on", points: 60 }))] },
    ]);
    const [off, on] = await listChallenges();
    expect(off.enabled).toBe(false);
    expect("enabled" in on).toBe(false);
  });

  it("gives the admin list the same field, for its status chip and edit form", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: row(challenge({ enabled: false })) },
      { result: ["chal-1", "CTF{x}"] },
      { result: [] },
    ]);
    const [admin] = await listChallengesForAdmin();
    expect(admin.challenge.enabled).toBe(false);
  });

  it("readChallengeRecords throws on a failed read instead of reporting an empty board", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH" }]);
    await expect(readChallengeRecords()).rejects.toThrow(/NOAUTH/);
  });

  it("readChallengeRecords returns every record, hidden ones included", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: row(challenge({ enabled: false })) }]);
    expect((await readChallengeRecords()).map((c) => [c.id, c.enabled])).toEqual([["chal-1", false]]);
  });
});

describe("writing it", () => {
  it("stores enabled:false on a disabled challenge and no field at all on a live one", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    await upsertChallenge(challenge({ id: "off", enabled: false }), "CTF{a}");
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    await upsertChallenge(challenge({ id: "on", enabled: true }), "CTF{b}");
    expect(storedRecord("off").enabled).toBe(false);
    // Absent, not true: a live record is byte-identical to one that predates
    // the field.
    expect("enabled" in storedRecord("on")).toBe(false);
  });

  it("returns the stored shape, so the admin list shows what was written", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    const saved = await upsertChallenge(challenge({ enabled: true }), "CTF{b}");
    expect("enabled" in saved.challenge).toBe(false);
  });

  it("a category rename keeps a disabled challenge disabled", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Webb"]) }]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: row(challenge({ category: "Webb", enabled: false })) }]);
    await renameCategory("Webb", "Web");
    expect(storedRecord("chal-1")).toMatchObject({ category: "Web", enabled: false });
  });

  it("an import writes enabled:false from the bundle and nothing for a live row", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: [] }, { result: null }]);
    await importBundle({
      version: 4,
      categories: ["Web"],
      challenges: [
        { id: "off", title: "Off", category: "Web", description: "", points: 1, order: 0, flag: "f", enabled: false },
        { id: "on", title: "On", category: "Web", description: "", points: 1, order: 1, flag: "f" },
      ],
    });
    expect(storedRecord("off").enabled).toBe(false);
    expect("enabled" in storedRecord("on")).toBe(false);
  });
});

describe("exporting it", () => {
  function seedBoard(records: Record<string, unknown>[]) {
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: records.flatMap(row) },
      { result: records.flatMap((r) => [r.id as string, "CTF{x}"]) },
      { result: [] },
    ]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: JSON.stringify(["Web"]) }]);
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: null }]);
  }

  it("emits enabled:false and stamps version 4, which an older box refuses rather than importing it live", async () => {
    seedBoard([challenge({ id: "off", enabled: false }), challenge({ id: "on", points: 60 })]);
    const bundle = await exportBundle();
    expect(bundle.version).toBe(4);
    expect(bundle.challenges.find((c) => c.id === "off")?.enabled).toBe(false);
    expect("enabled" in bundle.challenges.find((c) => c.id === "on")!).toBe(false);
    // Round-trips through the parser an import runs.
    const parsed = parseBundle(JSON.stringify(bundle));
    expect(parsed.ok).toBe(true);
  });

  it("keeps a board with every challenge live on version 2, so older boxes still import it", async () => {
    seedBoard([challenge({ id: "on" })]);
    expect((await exportBundle()).version).toBe(2);
  });
});
