// GET /api/hints — the viewer's own purchases. A hidden Jeopardy challenge
// does not exist for a contestant, for its buyers too: the text bought for it
// stays out of the response while it is hidden, and the spend still counts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  challenges: [] as Record<string, unknown>[],
  fail: false,
  storeReads: 0,
  requireLaunchedApi: vi.fn<(login: string | undefined) => Promise<Response | null>>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => ({ user: { id: ALICE_ID, login: "alice" } }) } } }));
vi.mock("@/lib/launch", () => ({ requireLaunchedApi: m.requireLaunchedApi }));
vi.mock("@/lib/hint-store", () => ({
  getViewerHints: async () => (m.storeReads++, {
    purchased: {},
    classic: { open: "open-hint-text", gone: "Withdrawn-hint-p2" },
    ai: {},
    spent: 20,
    count: 2,
  }),
  resolveHintConfig: async () => (m.storeReads++, { enabled: true, cost: 10 }),
}));
vi.mock("@/lib/classic-store", () => ({
  listChallenges: async () => {
    m.storeReads++;
    if (m.fail) throw new Error("NOAUTH");
    return m.challenges;
  },
}));

import { GET } from "@/app/api/hints/route";

const ALICE_ID = "0b9e4f3c-1d2a-4c5b-8e6f-7a8b9c0d1e2f";

const req = () => new Request("http://box/api/hints");

beforeEach(() => {
  m.fail = false;
  m.storeReads = 0;
  m.requireLaunchedApi.mockReset();
  m.requireLaunchedApi.mockResolvedValue(null);
  m.challenges = [{ id: "open" }, { id: "gone", enabled: false }];
});

describe("GET /api/hints and a hidden challenge", () => {
  it("leaves the hidden challenge's bought text out, and keeps the spend", async () => {
    const body = await (await GET(req())).json();
    expect(body.classic).toEqual({ open: "open-hint-text" });
    expect(JSON.stringify(body)).not.toContain("Withdrawn-hint-p2");
    expect(body.spent).toBe(20);
  });

  it("returns it again once the challenge is visible", async () => {
    m.challenges = [{ id: "open" }, { id: "gone" }];
    expect((await (await GET(req())).json()).classic).toEqual({ open: "open-hint-text", gone: "Withdrawn-hint-p2" });
  });

  it("returns no Jeopardy text when the challenges cannot be read", async () => {
    m.fail = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = await (await GET(req())).json();
    expect(body.classic).toEqual({});
    expect(body.spent).toBe(20);
  });
});

describe("GET /api/hints before launch", () => {
  it("403s with not-launched and reads no store", async () => {
    m.requireLaunchedApi.mockResolvedValue(Response.json({ error: "not-launched" }, { status: 403 }));
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not-launched" });
    expect(m.storeReads).toBe(0);
  });

  it("asks the lock about the viewer's GitHub login, the admin identity", async () => {
    await GET(req());
    expect(m.requireLaunchedApi).toHaveBeenCalledExactlyOnceWith("alice");
  });
});
