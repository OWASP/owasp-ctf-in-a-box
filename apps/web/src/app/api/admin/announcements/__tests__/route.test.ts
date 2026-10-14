// The /admin → Event Discord-announcements endpoints (#590). The invariants
// worth pinning at this layer: requireAdmin runs before any store call on
// every route; the config the GET returns never carries the webhook URL; a
// validation refusal is a 400 that names the problem; saving a webhook
// triggers the claim-only seed sweep; and the test route reports only an
// outcome, never the endpoint.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAnnounceConfig: vi.fn(),
  publicConfig: vi.fn((c: Record<string, unknown>) => {
    const rest = { ...c };
    delete rest.webhookUrl;
    return rest;
  }),
  updateAnnounceConfig: vi.fn(),
  setAnnounceWebhook: vi.fn(),
  getWebhookUrl: vi.fn(),
  readStatus: vi.fn(),
  seedReleaseClaims: vi.fn(),
  postToDiscord: vi.fn(),
  getAdminSettings: vi.fn(),
  writeAdminAudit: vi.fn(),
}));

class AnnounceValidationError extends Error {}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/admin-store", () => ({
  adminErrorLabel: (err: unknown) => (err instanceof Error ? err.message : "non-Error"),
  writeAdminAudit: mocks.writeAdminAudit,
  getAdminSettings: mocks.getAdminSettings,
}));
vi.mock("@/lib/announce/store", () => ({
  AnnounceValidationError,
  getAnnounceConfig: mocks.getAnnounceConfig,
  publicConfig: mocks.publicConfig,
  updateAnnounceConfig: mocks.updateAnnounceConfig,
  setAnnounceWebhook: mocks.setAnnounceWebhook,
  getWebhookUrl: mocks.getWebhookUrl,
  readStatus: mocks.readStatus,
}));
vi.mock("@/lib/announce/ticker", () => ({ seedReleaseClaims: mocks.seedReleaseClaims }));
vi.mock("@/lib/announce/sender", () => ({ postToDiscord: mocks.postToDiscord }));

const { GET, POST } = await import("@/app/api/admin/announcements/route");
const { POST: WEBHOOK } = await import("@/app/api/admin/announcements/webhook/route");
const { POST: TEST } = await import("@/app/api/admin/announcements/test/route");
const { POST: PREVIEW } = await import("@/app/api/admin/announcements/preview/route");

const URL = "https://discord.com/api/webhooks/1/aaaaaaaaaaaaaaaaaaaaaa";
const fullConfig = { webhookConfigured: true, releases: true, webhookUrl: URL };
const req = (method: string, body?: unknown, path = "/api/admin/announcements") =>
  new Request(`http://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === "function" && "mockReset" in m) (m as ReturnType<typeof vi.fn>).mockReset();
  mocks.requireAdmin.mockResolvedValue({ ok: true, login: "organizer" });
  mocks.getAnnounceConfig.mockResolvedValue(fullConfig);
  mocks.publicConfig.mockImplementation((c: Record<string, unknown>) => {
    const rest = { ...c };
    delete rest.webhookUrl;
    return rest;
  });
  mocks.readStatus.mockResolvedValue({ posted: {}, lastPostedAt: null, lastError: null, lastErrorAt: null });
  mocks.updateAnnounceConfig.mockResolvedValue({ webhookConfigured: true, releases: true });
  mocks.setAnnounceWebhook.mockResolvedValue({ webhookConfigured: true });
  mocks.seedReleaseClaims.mockResolvedValue(0);
  mocks.getWebhookUrl.mockResolvedValue(URL);
  mocks.postToDiscord.mockResolvedValue(true);
  mocks.getAdminSettings.mockRejectedValue(new Error("no settings"));
});

describe("the admin gate", () => {
  it.each([
    ["config GET", () => GET(req("GET"))],
    ["config POST", () => POST(req("POST", { releases: true }))],
    ["webhook POST", () => WEBHOOK(req("POST", { webhookUrl: URL }, "/api/admin/announcements/webhook"))],
    ["test POST", () => TEST(req("POST", undefined, "/api/admin/announcements/test"))],
    ["preview POST", () => PREVIEW(req("POST", { kind: "release" }, "/api/admin/announcements/preview"))],
  ])("%s refuses a non-admin before touching anything", async (_name, call) => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    expect((await call()).status).toBe(403);
    expect(mocks.getAnnounceConfig).not.toHaveBeenCalled();
    expect(mocks.updateAnnounceConfig).not.toHaveBeenCalled();
    expect(mocks.setAnnounceWebhook).not.toHaveBeenCalled();
    expect(mocks.postToDiscord).not.toHaveBeenCalled();
  });
});

describe("config GET", () => {
  it("returns the public config and status — never the webhook URL", async () => {
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: Record<string, unknown> };
    expect(body.config).not.toHaveProperty("webhookUrl");
    expect(JSON.stringify(body)).not.toContain(URL);
  });
});

describe("config POST", () => {
  it("refuses unknown keys and validation failures as 400", async () => {
    const unknown = await POST(req("POST", { bogus: true }));
    expect(unknown.status).toBe(400);
    expect(mocks.updateAnnounceConfig).not.toHaveBeenCalled();

    mocks.updateAnnounceConfig.mockRejectedValue(new AnnounceValidationError("marks is not a mark"));
    const invalid = await POST(req("POST", { marks: "soon" }));
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: string }).error).toContain("marks");
  });

  it("maps a store failure to 503", async () => {
    mocks.updateAnnounceConfig.mockRejectedValue(new Error("redis down"));
    expect((await POST(req("POST", { releases: true }))).status).toBe(503);
  });
});

describe("webhook POST", () => {
  it("stores the URL, runs the claim-only seed, and never returns the URL", async () => {
    const res = await WEBHOOK(req("POST", { webhookUrl: URL }, "/api/admin/announcements/webhook"));
    expect(res.status).toBe(200);
    expect(mocks.setAnnounceWebhook).toHaveBeenCalledWith("organizer", URL);
    expect(mocks.seedReleaseClaims).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await res.json())).not.toContain(URL);
  });

  it("clearing does not seed", async () => {
    mocks.setAnnounceWebhook.mockResolvedValue({ webhookConfigured: false });
    await WEBHOOK(req("POST", { webhookUrl: null }, "/api/admin/announcements/webhook"));
    expect(mocks.seedReleaseClaims).not.toHaveBeenCalled();
  });

  it("a validation refusal is a 400 naming the problem", async () => {
    mocks.setAnnounceWebhook.mockRejectedValue(new AnnounceValidationError("webhook URL must be on discord.com"));
    const res = await WEBHOOK(req("POST", { webhookUrl: "https://evil.example/x" }, "/api/admin/announcements/webhook"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("discord.com");
  });
});

describe("test POST", () => {
  it("posts the test message and reports only the outcome", async () => {
    const res = await TEST(req("POST", undefined, "/api/admin/announcements/test"));
    expect(res.status).toBe(200);
    expect(mocks.postToDiscord).toHaveBeenCalledWith(URL, expect.objectContaining({ allowed_mentions: { parse: [] } }));
    expect(JSON.stringify(await res.json())).not.toContain(URL);
  });

  it("a rejected POST is a 502 with no endpoint in the body", async () => {
    mocks.postToDiscord.mockResolvedValue(false);
    const res = await TEST(req("POST", undefined, "/api/admin/announcements/test"));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(URL);
  });

  it("no webhook configured is a 400", async () => {
    mocks.getWebhookUrl.mockResolvedValue(null);
    expect((await TEST(req("POST", undefined, "/api/admin/announcements/test"))).status).toBe(400);
  });
});

describe("preview POST", () => {
  it("returns a sample message for a known kind, with mentions suppressed", async () => {
    const res = await PREVIEW(req("POST", { kind: "release" }, "/api/admin/announcements/preview"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { allowed_mentions: unknown } };
    expect(body.message.allowed_mentions).toEqual({ parse: [] });
  });

  it("refuses an unknown kind", async () => {
    expect((await PREVIEW(req("POST", { kind: "nope" }, "/api/admin/announcements/preview"))).status).toBe(400);
  });
});
