// Route-level tests for the sponsors organizer authoring route. Auth guard,
// sponsors-store, and the shared admin-store audit/error helpers are mocked
// — no Redis or GitHub session needed.
//
// requireAdmin must run BEFORE any store read/write, same invariant every
// other admin-* route test pins.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireAdmin, listSponsorsForAdmin, upsertSponsor, deleteSponsor, reorderSponsors, writeAdminAudit, SponsorValidationError } =
  vi.hoisted(() => {
    class SponsorValidationError extends Error {
      field: string;
      constructor(field: string, message: string) {
        super(message);
        this.name = "SponsorValidationError";
        this.field = field;
      }
    }
    return {
      requireAdmin: vi.fn(),
      listSponsorsForAdmin: vi.fn(),
      upsertSponsor: vi.fn(),
      deleteSponsor: vi.fn(),
      reorderSponsors: vi.fn(),
      writeAdminAudit: vi.fn(),
      SponsorValidationError,
    };
  });

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin }));
vi.mock("@/lib/sponsors-store", () => ({
  listSponsorsForAdmin,
  upsertSponsor,
  deleteSponsor,
  reorderSponsors,
  SponsorValidationError,
}));
vi.mock("@/lib/admin-store", () => ({
  writeAdminAudit,
  adminErrorLabel: (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : "non-Error throw"),
}));

const { GET, POST, DELETE } = await import("@/app/api/admin/sponsors/route");

const VALID = { id: "acme-ab12cd", name: "Acme", url: "https://acme.example", blurb: "", tier: "gold", order: 0 };

function adminReq(method: "GET" | "POST" | "DELETE", body?: unknown, headers?: Record<string, string>) {
  return new Request("http://x/api/admin/sponsors", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  });
}

/** A request whose body stream reports a total size over `bytes`, regardless
 *  of what its (or a missing) Content-Length header claims — this is the
 *  shape a spoofed/absent header cannot defend against. */
function oversizedReq(bytes: number): Request {
  const chunk = new Uint8Array(1024).fill(97);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let sent = 0;
      while (sent < bytes) {
        controller.enqueue(chunk);
        sent += chunk.length;
      }
      controller.close();
    },
  });
  return new Request("http://x/api/admin/sponsors", { method: "POST", body: stream, duplex: "half" } as RequestInit);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue({ ok: true, login: "organizer" });
});

describe("GET /api/admin/sponsors", () => {
  it("requires admin before reading the store", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    const res = await GET(adminReq("GET"));
    expect(res.status).toBe(403);
    expect(listSponsorsForAdmin).not.toHaveBeenCalled();
  });

  it("returns the sponsor list", async () => {
    listSponsorsForAdmin.mockResolvedValue([VALID]);
    const res = await GET(adminReq("GET"));
    expect(await res.json()).toEqual({ sponsors: [VALID] });
  });
});

describe("POST /api/admin/sponsors — upsert", () => {
  it("requires admin before writing", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    await POST(adminReq("POST", VALID));
    expect(upsertSponsor).not.toHaveBeenCalled();
  });

  it("upserts and audits", async () => {
    upsertSponsor.mockResolvedValue(VALID);
    const res = await POST(adminReq("POST", VALID));
    expect(res.status).toBe(200);
    expect(upsertSponsor).toHaveBeenCalledWith(
      { id: VALID.id, name: VALID.name, url: VALID.url, blurb: VALID.blurb, tier: VALID.tier, order: VALID.order },
      undefined,
    );
    expect(writeAdminAudit).toHaveBeenCalledWith("organizer", "sponsors-upsert", { sponsorId: VALID.id });
  });

  it("passes a logo upload through as the three-valued logo argument", async () => {
    upsertSponsor.mockResolvedValue(VALID);
    await POST(adminReq("POST", { ...VALID, logoBase64: "aGk=", logoType: "image/png" }));
    expect(upsertSponsor).toHaveBeenCalledWith(expect.anything(), { data: "aGk=", declaredType: "image/png" });
  });

  it("passes null (clear) when clearLogo is set", async () => {
    upsertSponsor.mockResolvedValue(VALID);
    await POST(adminReq("POST", { ...VALID, clearLogo: true }));
    expect(upsertSponsor).toHaveBeenCalledWith(expect.anything(), null);
  });

  it("maps a SponsorValidationError to 400 with its field", async () => {
    upsertSponsor.mockRejectedValue(new SponsorValidationError("url", "bad url"));
    const res = await POST(adminReq("POST", VALID));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad url", field: "url" });
  });

  it("maps a plain store error to 503", async () => {
    upsertSponsor.mockRejectedValue(new Error("Upstash down"));
    const res = await POST(adminReq("POST", VALID));
    expect(res.status).toBe(503);
  });

  it("rejects a payload with an unknown key", async () => {
    const res = await POST(adminReq("POST", { ...VALID, sneaky: 1 }));
    expect(res.status).toBe(400);
    expect(upsertSponsor).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with 400, not a crash", async () => {
    const res = await POST(new Request("http://x/api/admin/sponsors", { method: "POST", body: "{not json" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/admin/sponsors — reorder", () => {
  it("dispatches to reorderSponsors and audits", async () => {
    reorderSponsors.mockResolvedValue([VALID]);
    const res = await POST(adminReq("POST", { reorder: ["a", "b"] }));
    expect(reorderSponsors).toHaveBeenCalledWith(["a", "b"]);
    expect(await res.json()).toEqual({ sponsors: [VALID] });
    expect(writeAdminAudit).toHaveBeenCalledWith("organizer", "sponsors-reorder", { count: 1 });
  });
});

describe("POST /api/admin/sponsors — bounded body read", () => {
  it("rejects a body over the size cap even with no Content-Length header, before ever parsing it", async () => {
    const res = await POST(oversizedReq(300_000));
    expect(res.status).toBe(413);
    expect(upsertSponsor).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/sponsors", () => {
  it("requires admin before deleting", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    await DELETE(adminReq("DELETE", { id: "acme" }));
    expect(deleteSponsor).not.toHaveBeenCalled();
  });

  it("deletes and audits", async () => {
    const res = await DELETE(adminReq("DELETE", { id: "acme" }));
    expect(res.status).toBe(200);
    expect(deleteSponsor).toHaveBeenCalledWith("acme");
    expect(writeAdminAudit).toHaveBeenCalledWith("organizer", "sponsors-delete", { sponsorId: "acme" });
  });

  it("rejects a missing id", async () => {
    const res = await DELETE(adminReq("DELETE", {}));
    expect(res.status).toBe(400);
    expect(deleteSponsor).not.toHaveBeenCalled();
  });

  it("rejects an id that fails SPONSOR_ID_RE before it can reach the store or the audit log", async () => {
    const res = await DELETE(adminReq("DELETE", { id: "not a valid id! (a flag-shaped string, say)" }));
    expect(res.status).toBe(400);
    expect(deleteSponsor).not.toHaveBeenCalled();
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });
});
