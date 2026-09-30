// GET /api/attachments/[id] (#186): bytes only for a viewer who can see the
// challenge — the SAME classicVisibility answer the page uses — and always as
// a download, never rendered from our origin.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLANTED_LOG_SECRET, decoratedError, expectLabelOnly } from "@/lib/__tests__/log-redaction";

const m = vi.hoisted(() => ({
  login: "alice" as string | undefined,
  state: "visible" as string,
  resolved: null as null | { module: "classic"; itemId: string; attachment: Record<string, unknown> },
  bytes: new Uint8Array([60, 104, 49, 62]),
  fail: false,
  failWith: undefined as unknown,
  visibilityCalls: [] as [string | undefined, string][],
  launched: true,
  resolveCalls: 0,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => (m.login ? { user: { login: m.login } } : null) } },
}));
vi.mock("@/lib/classic-visibility", () => ({
  classicVisibility: async (login: string | undefined, id: string) => {
    m.visibilityCalls.push([login, id]);
    if (m.fail) throw m.failWith ?? new Error("redis down");
    return { state: m.state, preview: false };
  },
}));
vi.mock("@/lib/launch", () => ({
  requireLaunchedApi: async () =>
    m.launched ? null : new Response(JSON.stringify({ error: "not-launched" }), { status: 403, headers: { "content-type": "application/json" } }),
}));
vi.mock("@/lib/attachments-store", () => ({
  resolveAttachment: async () => {
    m.resolveCalls += 1;
    return m.resolved;
  },
  readUploadBytes: async () => m.bytes,
}));

import { GET } from "@/app/api/attachments/[id]/route";

const ID = "a0123456789abcdef";
const upload = { id: ID, kind: "upload", name: "evil.html", size: 4, sha256: "ab".repeat(32), chunks: 1 };
const get = (headers: Record<string, string> = {}, id = ID) =>
  GET(new Request(`http://x/api/attachments/${id}`, { headers }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  m.login = "alice";
  m.state = "visible";
  m.resolved = { module: "classic", itemId: "web-one", attachment: { ...upload } };
  m.fail = false;
  m.failWith = undefined;
  m.visibilityCalls = [];
  m.launched = true;
  m.resolveCalls = 0;
});

describe("GET /api/attachments/[id]", () => {
  // CodeRabbit #472: the module-API launch contract — 403 not-launched,
  // decided before the attachment is even looked up.
  it("answers 403 not-launched before launch, without resolving the attachment", async () => {
    m.launched = false;
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not-launched" });
    expect(m.resolveCalls).toBe(0);
  });

  it("serves an uploaded .html as an opaque download, never rendered", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="evil\.html"/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("etag")).toBe(`"${"ab".repeat(32)}"`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(m.bytes);
  });

  it("asks the challenge's own visibility, for this viewer and this item", async () => {
    await get();
    expect(m.visibilityCalls).toEqual([["alice", "web-one"]]);
  });

  it.each(["module-off", "not-launched", "teamless", "missing", "locked"])(
    "404s while the challenge is %s, and serves once it is visible (not vacuous)",
    async (state) => {
      m.state = state;
      const hidden = await get();
      expect(hidden.status).toBe(404);
      m.state = "visible";
      expect((await get()).status).toBe(200);
    },
  );

  it("404s an unknown id and a malformed one the same way, without a visibility read", async () => {
    m.resolved = null;
    const unknown = await get();
    const malformed = await get({}, "..%2F..%2Fetc");
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await unknown.text()).toBe(await malformed.text());
    expect(m.visibilityCalls).toEqual([]);
  });

  it("never answers 304 for a hidden attachment, even with its ETag", async () => {
    m.state = "locked";
    expect((await get({ "if-none-match": `"${"ab".repeat(32)}"` })).status).toBe(404);
  });

  it("404s a link (never proxied) and an upload still missing its bytes", async () => {
    m.resolved = { module: "classic", itemId: "web-one", attachment: { id: ID, kind: "link", name: "x", url: "https://e.org/x" } };
    expect((await get()).status).toBe(404);
    m.resolved = { module: "classic", itemId: "web-one", attachment: { ...upload, missing: true } };
    expect((await get()).status).toBe(404);
  });

  it("answers 304 for a matching If-None-Match, and 503 when a read fails", async () => {
    expect((await get({ "if-none-match": `"${"ab".repeat(32)}"` })).status).toBe(304);
    m.fail = true;
    expect((await get()).status).toBe(503);
  });

  // A thrown string could BE a secret, and `new Error(String(err))` printed
  // it; a decorated Error must reach the log as its label only (#500).
  it("logs the label only on a failed read: never a thrown non-Error, never the decoration", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      m.fail = true;
      m.failWith = PLANTED_LOG_SECRET;
      expect((await get()).status).toBe(503);
      expectLabelOnly(log, { label: "non-Error throw" });
      m.failWith = decoratedError("redis down");
      expect((await get()).status).toBe(503);
      expectLabelOnly(log, { label: "redis down" });
    } finally {
      log.mockRestore();
    }
  });
});
