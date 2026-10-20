// The classic bundle route: GET hands the panel's Export the uploads' bytes
// when the organizer asks for them, POST imports a bundle that may carry
// them. It sits outside the Next proxy (proxy-matcher.test.ts pins that) so a
// bundle with files is not cut at 10 MB, which makes the origin check and the
// bounded read this route's own.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class ClassicValidationError extends Error {
    constructor(
      public field: string,
      message: string,
    ) {
      super(message);
    }
  }
  class AttachmentFilesError extends Error {
    constructor(
      public where: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    requireAdmin: vi.fn(),
    writeAdminAudit: vi.fn(),
    importClassicBundle: vi.fn(),
    exportAttachmentFiles: vi.fn(),
    ClassicValidationError,
    AttachmentFilesError,
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/admin-store", () => ({
  writeAdminAudit: h.writeAdminAudit,
  adminErrorLabel: (err: unknown) => (err instanceof Error ? err.name : "non-Error throw"),
}));
vi.mock("@/lib/classic-store", () => ({ ClassicValidationError: h.ClassicValidationError }));
vi.mock("@/lib/attachments-store", () => ({ AttachmentError: class AttachmentError extends Error {} }));
vi.mock("@/lib/attachment-files-store", () => ({
  importClassicBundle: h.importClassicBundle,
  exportAttachmentFiles: h.exportAttachmentFiles,
  AttachmentFilesError: h.AttachmentFilesError,
}));

import { CLASSIC_IMPORT_MAX_BYTES, GET, POST } from "@/app/api/admin/classic/bundle/route";

const MB = 1024 * 1024;
const URL_ = "http://box.test/api/admin/classic/bundle";
const validRaw = JSON.stringify({
  version: 3,
  categories: ["Web"],
  challenges: [{ id: "web-one-ab12cd", title: "One", category: "Web", description: "", points: 1, order: 0, flag: "f" }],
});
const post = (body: unknown) => new Request(URL_, { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, login: "alice" });
  h.importClassicBundle.mockResolvedValue({ created: 1, updated: 0, categories: 1 });
  h.exportAttachmentFiles.mockResolvedValue([{ item: "web-one-ab12cd", sha256: "ab".repeat(32), bytes: "AAAA" }]);
});

describe("GET /api/admin/classic/bundle", () => {
  it("403s a non-admin before reading a single byte", async () => {
    h.requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    const res = await GET(new Request(URL_));
    expect(res.status).toBe(403);
    expect(h.exportAttachmentFiles).not.toHaveBeenCalled();
  });

  it("returns every stored upload's bytes for an admin", async () => {
    const res = await GET(new Request(URL_));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ attachmentFiles: [{ item: "web-one-ab12cd", sha256: "ab".repeat(32), bytes: "AAAA" }] });
  });

  it("503s when the bytes cannot be read, never a partial list", async () => {
    h.exportAttachmentFiles.mockRejectedValue(new Error("attachments: chunk 0 of a1 is missing"));
    const res = await GET(new Request(URL_));
    expect(res.status).toBe(503);
  });
});

describe("POST /api/admin/classic/bundle", () => {
  it("403s a non-admin and never imports", async () => {
    h.requireAdmin.mockResolvedValue({ ok: false, status: 403 });
    const res = await POST(post({ import: validRaw }));
    expect(res.status).toBe(403);
    expect(h.importClassicBundle).not.toHaveBeenCalled();
  });

  it("re-validates the text with the real parser and imports it", async () => {
    const res = await POST(post({ import: validRaw }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 1, updated: 0, categories: 1 });
    expect(h.importClassicBundle).toHaveBeenCalledWith(expect.objectContaining({ version: 3 }));
    expect(h.writeAdminAudit).toHaveBeenCalledWith("alice", "classic-import", { created: 1, updated: 0, categories: 1 });
  });

  it("audits how many files the import filled", async () => {
    h.importClassicBundle.mockResolvedValue({ created: 1, updated: 0, categories: 1, files: 2 });
    await POST(post({ import: validRaw }));
    expect(h.writeAdminAudit).toHaveBeenCalledWith("alice", "classic-import", { created: 1, updated: 0, categories: 1, files: 2 });
  });

  it("400s an invalid bundle with the parser's errors and never imports", async () => {
    const res = await POST(post({ import: "{not json" }));
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toEqual([{ where: "(document)", message: "Invalid JSON" }]);
    expect(h.importClassicBundle).not.toHaveBeenCalled();
  });

  it("400s a body with any key besides import", async () => {
    const res = await POST(post({ import: validRaw, sneaky: 1 }));
    expect(res.status).toBe(400);
    expect(h.importClassicBundle).not.toHaveBeenCalled();
  });

  it("400s a refused file, naming where", async () => {
    h.importClassicBundle.mockRejectedValue(new h.AttachmentFilesError("attachmentFiles[0]", "attachmentFiles[0]: the bytes do not match the file's sha256"));
    const res = await POST(post({ import: validRaw }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "attachmentFiles[0]: the bytes do not match the file's sha256", field: "attachmentFiles[0]" });
  });

  it("400s a store validation refusal and 503s an infrastructure failure", async () => {
    h.importClassicBundle.mockRejectedValueOnce(new h.ClassicValidationError("attachments", "At most 10 attachments per challenge"));
    expect((await POST(post({ import: validRaw }))).status).toBe(400);
    h.importClassicBundle.mockRejectedValueOnce(new Error("upstash down"));
    expect((await POST(post({ import: validRaw }))).status).toBe(503);
  });

  it("413s a declared body over the cap before reading it", async () => {
    const req = new Request(URL_, {
      method: "POST",
      body: JSON.stringify({ import: validRaw }),
      headers: { "content-type": "application/json", "content-length": String(CLASSIC_IMPORT_MAX_BYTES + 1) },
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe(`A bundle import can be at most ${Math.round(CLASSIC_IMPORT_MAX_BYTES / MB)} MB`);
    expect(h.importClassicBundle).not.toHaveBeenCalled();
  });

  it("sizes the cap for a full event of attachments as base64, plus headroom", () => {
    expect(CLASSIC_IMPORT_MAX_BYTES).toBeGreaterThan(Math.ceil((50 * MB * 4) / 3));
  });
});

// Through the Next proxy a body past 10 MB arrived cut short. These pin the
// route's half of being outside it: a body past 10 MB is read whole, and one
// past the cap is refused with a 413 naming the cap even when it declares no
// length.
describe("POST /api/admin/classic/bundle — bodies past the proxy's 10 MB", () => {
  function streamedRequest(total: number): Request {
    let sent = 0;
    const chunk = new Uint8Array(MB).fill(0x20);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) return controller.close();
        const n = Math.min(MB, total - sent);
        controller.enqueue(n === MB ? chunk : chunk.subarray(0, n));
        sent += n;
      },
    });
    return new Request(URL_, { method: "POST", body, duplex: "half" } as RequestInit);
  }

  it("imports a 12 MB bundle whole", async () => {
    const padded = `{${" ".repeat(12 * MB)}${validRaw.slice(1)}`;
    const body = JSON.stringify({ import: padded });
    expect(body.length).toBeGreaterThan(12 * MB);
    const res = await POST(new Request(URL_, { method: "POST", body }));
    expect(res.status).toBe(200);
    expect(h.importClassicBundle).toHaveBeenCalledTimes(1);
  });

  it("413s a streamed body over the cap, naming the cap, without importing", async () => {
    const res = await POST(streamedRequest(CLASSIC_IMPORT_MAX_BYTES + MB));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe(`A bundle import can be at most ${Math.round(CLASSIC_IMPORT_MAX_BYTES / MB)} MB`);
    expect(h.importClassicBundle).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/classic/bundle — origin check in place of the proxy's", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_URL", "https://ctf.example.org");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const withOrigin = (origin: string) =>
    new Request("https://ctf.example.org/api/admin/classic/bundle", {
      method: "POST",
      headers: { origin },
      body: JSON.stringify({ import: validRaw }),
    });

  it("403s a cross-origin POST before the admin gate or the import", async () => {
    const res = await POST(withOrigin("https://evil.example"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross-origin request refused" });
    expect(h.requireAdmin).not.toHaveBeenCalled();
    expect(h.importClassicBundle).not.toHaveBeenCalled();
  });

  it("lets the event's own origin through", async () => {
    const res = await POST(withOrigin("https://ctf.example.org"));
    expect(res.status).toBe(200);
    expect(h.importClassicBundle).toHaveBeenCalled();
  });
});
