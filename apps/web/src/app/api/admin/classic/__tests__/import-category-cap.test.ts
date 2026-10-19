import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpstashResult } from "@/lib/upstash";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  writeAdminAudit: vi.fn(),
  upstashPipeline: vi.fn<(commands: (string | number)[][]) => Promise<UpstashResult[]>>(),
  upstashEval: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/admin-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-store")>()),
  writeAdminAudit: mocks.writeAdminAudit,
}));
vi.mock("@/lib/upstash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/upstash")>()),
  upstashPipeline: mocks.upstashPipeline,
  upstashEval: mocks.upstashEval,
}));

import { POST as postClassic } from "@/app/api/admin/classic/route";
import { POST as postBundle } from "@/app/api/admin/classic/bundle/route";
import { parseBundle } from "@/lib/classic-io";
import { CLASSIC_CATEGORIES_MAX } from "@/lib/classic-keys";

const id = "existing";
const uploadId = "a0123456789abcdef";
const bytes = Buffer.from("category-cap upload");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const upload = { name: "evidence.txt", size: bytes.length, sha256 };
const raw = JSON.stringify({
  version: 3,
  categories: ["Incoming"],
  challenges: [{
    id, title: "Changed", category: "Incoming", description: "Changed description", points: 20, order: 0,
    flag: "CTF{changed-secret}", hint: "changed secret hint",
    attachments: [upload, { name: "new-link", url: "https://example.org/file" }],
  }],
  stories: [{ id: "operation", title: "Changed story", intro: "", steps: [id] }],
  attachmentFiles: [{ item: id, sha256, bytes: bytes.toString("base64") }],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, login: "organizer" });
  mocks.upstashEval.mockResolvedValue(["ok"]);
  const replies = new Map<string, unknown>([
    [JSON.stringify(["HKEYS", "ctf:classic:challenges"]), [id]],
    [JSON.stringify(["GET", "ctf:classic:categories"]), JSON.stringify(
      Array.from({ length: CLASSIC_CATEGORIES_MAX }, (_, i) => `Existing ${i}`),
    )],
    [JSON.stringify(["GET", "ctf:classic:stories"]), JSON.stringify([
      { id: "operation", title: "Original story", intro: "", steps: [id] },
    ])],
    [JSON.stringify(["HGET", "ctf:attachments:meta", `classic:${id}`]), JSON.stringify([
      { id: uploadId, kind: "upload", ...upload, missing: true },
    ])],
    [JSON.stringify(["GET", "ctf:attachments:bytes"]), 0],
    [JSON.stringify(["HGET", "ctf:attachments:index", uploadId]), `classic:${id}`],
  ]);
  // Writes succeed in the transport stub so an unguarded import reaches its
  // real upload fill and success audit; the assertions below reject both.
  mocks.upstashPipeline.mockImplementation(async (commands) => commands.map((command) => {
    const key = JSON.stringify(command);
    if (replies.has(key)) return { result: replies.get(key) };
    if (["SET", "HSET", "HDEL"].includes(String(command[0]))) return { result: 1 };
    throw new Error(`Unexpected Redis command: ${key}`);
  }));
});

describe("Classic category cap through the import routes", () => {
  it.each([
    { path: "/api/admin/classic", post: postClassic },
    { path: "/api/admin/classic/bundle", post: postBundle },
  ])("$path refuses the merged overflow before writes, upload fills or audit", async ({ path, post }) => {
    expect(parseBundle(raw).ok).toBe(true);
    const response = await post(new Request(`http://box.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ import: raw }),
    }));
    const body = await response.json();

    expect.soft(response.status).toBe(400);
    expect.soft(body).toEqual({
      field: "categories",
      error: expect.stringContaining(String(CLASSIC_CATEGORIES_MAX)),
    });
    expect.soft(JSON.stringify(body)).not.toContain("changed-secret");
    expect.soft(JSON.stringify(body)).not.toContain("changed secret hint");
    const commands = mocks.upstashPipeline.mock.calls.flatMap(([batch]) => batch);
    expect.soft(commands.filter(([operation]) => !["GET", "HGET", "HKEYS"].includes(String(operation)))).toEqual([]);
    expect.soft(mocks.upstashEval).not.toHaveBeenCalled();
    expect.soft(mocks.writeAdminAudit).not.toHaveBeenCalled();
  });
});
