// GET /api/hints — the viewer's own purchases. A hidden Jeopardy challenge
// does not exist for a contestant, for its buyers too: the text bought for it
// stays out of the response while it is hidden, and the spend still counts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  challenges: [] as Record<string, unknown>[],
  fail: false,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => ({ user: { login: "alice" } }) } } }));
vi.mock("@/lib/hint-store", () => ({
  getViewerHints: async () => ({
    purchased: {},
    classic: { open: "open-hint-text", gone: "Withdrawn-hint-p2" },
    ai: {},
    spent: 20,
    count: 2,
  }),
  resolveHintConfig: async () => ({ enabled: true, cost: 10 }),
}));
vi.mock("@/lib/classic-store", () => ({
  listChallenges: async () => {
    if (m.fail) throw new Error("NOAUTH");
    return m.challenges;
  },
}));

import { GET } from "@/app/api/hints/route";

const req = () => new Request("http://box/api/hints");

beforeEach(() => {
  m.fail = false;
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
