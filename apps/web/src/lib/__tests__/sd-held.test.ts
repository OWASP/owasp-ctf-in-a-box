import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ upstashPipeline: vi.fn(), getAdminSettings: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", async (orig) => ({
  ...(await orig<typeof import("@/lib/upstash")>()),
  upstashPipeline: h.upstashPipeline,
}));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings: h.getAdminSettings }));

import { listHeldScores } from "@/lib/sd-held";

const END = "2026-11-20T12:00:00.000Z";
const endMs = Date.parse(END);
const row = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ target: "dvwa", solved: ["a", "b"], pr: 7, sha: "abc", at: "2026-11-19T10:00:00.000Z", repo: "fork", ...over });
const flat = (o: Record<string, string>) => Object.entries(o).flat();

/** Routes the three pipelines by their first command. */
function seed(opts: {
  authors: string[];
  held: Record<string, Record<string, string>>;
  links?: Record<string, string | null>;
  at?: Record<string, string | null>;
  endsAt: string | null;
}) {
  h.getAdminSettings.mockResolvedValue({ scoringEndsAt: opts.endsAt });
  h.upstashPipeline.mockImplementation(async (cmds: string[][]) => {
    const first = cmds[0]?.[0];
    if (first === "SMEMBERS") return [{ result: opts.authors }];
    if (first === "HGETALL") return cmds.map((c) => ({ result: flat(opts.held[c[1].replace("ctf:sd:held:by:", "")] ?? {}) }));
    if (first === "GET") return cmds.map((c) => ({ result: opts.links?.[c[1].replace("ctf:link:github:", "")] ?? null }));
    if (first === "HGET") return cmds.map((c) => ({ result: opts.at?.[c[2]] ?? null }));
    return [];
  });
}

beforeEach(() => {
  h.upstashPipeline.mockReset();
  h.getAdminSettings.mockReset();
});

describe("listHeldScores", () => {
  it("is held while the window is open and the author is unlinked", async () => {
    seed({ authors: ["octo"], held: { octo: { "1@t": row() } }, endsAt: END });
    const out = await listHeldScores(endMs - 1000);
    expect(out).toEqual([
      { login: "octo", target: "dvwa", solved: ["a", "b"], pr: 7, at: "2026-11-19T10:00:00.000Z", status: "held" },
    ]);
  });

  it("is held with no scoring end set, even for a linked author", async () => {
    seed({ authors: ["octo"], held: { octo: { "1@t": row() } }, links: { octo: "p1" }, at: { p1: String(endMs + 5) }, endsAt: null });
    expect((await listHeldScores(endMs + 99999))[0].status).toBe("held");
  });

  it("is unclaimed once the window has closed", async () => {
    seed({ authors: ["octo"], held: { octo: { "1@t": row() } }, endsAt: END });
    expect((await listHeldScores(endMs))[0].status).toBe("unclaimed");
  });

  it("is held when the author linked before the close", async () => {
    seed({ authors: ["octo"], held: { octo: { "1@t": row() } }, links: { octo: "p1" }, at: { p1: String(endMs - 1) }, endsAt: END });
    expect((await listHeldScores(endMs - 1000))[0].status).toBe("held");
  });

  it("is unclaimed when the author linked at or after the close, even with the window clock earlier", async () => {
    seed({ authors: ["octo"], held: { octo: { "1@t": row() } }, links: { octo: "p1" }, at: { p1: String(endMs) }, endsAt: END });
    expect((await listHeldScores(endMs - 1000))[0].status).toBe("unclaimed");
  });

  it("stays held after the close while the author linked before it, as sync still releases it", async () => {
    seed({ authors: ["octo"], held: { octo: { "1@t": row() } }, links: { octo: "p1" }, at: { p1: String(endMs - 1) }, endsAt: END });
    expect((await listHeldScores(endMs + 1))[0].status).toBe("held");
  });

  it.each(["", " ", "-5", "1e3", "12.5"])("treats link time %j as no time, after the close", async (raw) => {
    seed({ authors: ["octo"], held: { octo: { "1@t": row() } }, links: { octo: "p1" }, at: { p1: raw }, endsAt: END });
    expect((await listHeldScores(endMs - 1000))[0].status).toBe("unclaimed");
  });

  it("treats a linked author with no link time as after the close", async () => {
    seed({ authors: ["octo"], held: { octo: { "1@t": row() } }, links: { octo: "p1" }, endsAt: END });
    expect((await listHeldScores(endMs - 1000))[0].status).toBe("unclaimed");
  });

  it("treats an unparseable scoringEndsAt as no end", async () => {
    seed({ authors: ["octo"], held: { octo: { "1@t": row() } }, endsAt: "garbage" });
    expect((await listHeldScores(endMs + 1))[0].status).toBe("held");
  });

  it("skips rows whose JSON or time will not parse and sorts the rest by time", async () => {
    seed({
      authors: ["octo", "zed"],
      held: {
        octo: { "1@t": "{not json", "2@t": row({ at: "nope" }), "3@t": row({ at: "2026-11-19T12:00:00.000Z", pr: 3 }) },
        zed: { "4@t": row({ at: "2026-11-19T09:00:00.000Z", pr: 4 }) },
      },
      endsAt: END,
    });
    const out = await listHeldScores(endMs - 1000);
    expect(out.map((e) => [e.login, e.pr])).toEqual([["zed", 4], ["octo", 3]]);
  });

  it("returns an empty list with no authors, reading no per-author keys", async () => {
    seed({ authors: [], held: {}, endsAt: END });
    expect(await listHeldScores()).toEqual([]);
    expect(h.upstashPipeline).toHaveBeenCalledTimes(1);
  });

  it("throws when a command fails", async () => {
    h.getAdminSettings.mockResolvedValue({ scoringEndsAt: null });
    h.upstashPipeline.mockResolvedValue([{ error: "NOAUTH" }]);
    await expect(listHeldScores()).rejects.toThrow(/NOAUTH/);
  });
});
