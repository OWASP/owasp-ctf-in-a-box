// Route-level tests for the ai module's organizer authoring route. Auth
// guard, ai-store, and the shared admin-store audit/error helpers
// (`writeAdminAudit`/`adminErrorLabel` — see admin-store.ts) are all mocked —
// no Redis or GitHub session needed.
//
// requireAdmin must run BEFORE any store read/write in every handler: the
// admin payload carries flags and signing keys, so an early read on an
// unauthenticated request is not merely wasted work, it is the leak itself.
// Mirrors admin/classic/route.test.ts's idiom, with the ai deltas: mode +
// urlTemplate in the challenge payload, a `{ rotate }` dispatch arm, and no
// import/export arm.

import { inspect } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireAdmin,
  listAiChallengesForAdmin,
  listAiCategories,
  setAiCategories,
  upsertAiChallenge,
  deleteAiChallenge,
  rotateAiSigningKey,
  renameAiCategory,
  writeAdminAudit,
  AiValidationError,
} = vi.hoisted(() => {
  // A real (not mocked) AiValidationError, so `err instanceof
  // AiValidationError` in the route sees the exact same class the test
  // constructs errors with — that's what makes the 400-vs-503 split testable
  // at all.
  class AiValidationError extends Error {
    field: string;
    constructor(field: string, message: string) {
      super(message);
      this.name = "AiValidationError";
      this.field = field;
    }
  }
  return {
    requireAdmin: vi.fn(),
    listAiChallengesForAdmin: vi.fn(),
    listAiCategories: vi.fn(),
    setAiCategories: vi.fn(),
    upsertAiChallenge: vi.fn(),
    deleteAiChallenge: vi.fn(),
    rotateAiSigningKey: vi.fn(),
    renameAiCategory: vi.fn(),
    writeAdminAudit: vi.fn(),
    AiValidationError,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin }));
vi.mock("@/lib/ai-store", () => ({
  listAiChallengesForAdmin,
  listAiCategories,
  setAiCategories,
  upsertAiChallenge,
  deleteAiChallenge,
  rotateAiSigningKey,
  renameAiCategory,
  AiValidationError,
}));
// `adminErrorLabel` is the real (name+message, capped) implementation, not a
// mock — the redaction assertion below needs it to actually behave like
// admin-store.ts's real one, dropping any own properties a driver decorated
// the thrown error with.
vi.mock("@/lib/admin-store", () => ({
  writeAdminAudit,
  adminErrorLabel: (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "non-Error throw"),
}));

import { GET, POST, DELETE, CHALLENGE_KEYS, CATEGORIES_KEYS, ROTATE_KEYS } from "@/app/api/admin/ai/route";

import { CATEGORY_CONFLICT_MESSAGE, CategoryConflictError } from "@/lib/category-cas";

const adminReq = (method: "GET" | "POST" | "DELETE", body?: unknown) =>
  new Request("http://x/api/admin/ai", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const CHALLENGE = {
  id: "c-1",
  title: "Prompt Injection 101",
  category: "AI",
  description: "Find the flag.",
  points: 50,
  order: 1,
  mode: "flag" as const,
  urlTemplate: "https://challenge.example/{token}",
};

const validPayload = { ...CHALLENGE, flag: "CTF{flag}" };

const ADMIN_ROW = { challenge: CHALLENGE, flag: "CTF{flag}", hint: null, signingKey: "signkey-abc" };

function allowAdmin() {
  requireAdmin.mockResolvedValue({ ok: true, login: "alice" });
}

function denyAdmin() {
  requireAdmin.mockResolvedValue({ ok: false, status: 403 });
}

beforeEach(() => {
  requireAdmin.mockReset();
  renameAiCategory.mockReset();
  listAiChallengesForAdmin.mockReset();
  listAiCategories.mockReset();
  setAiCategories.mockReset();
  upsertAiChallenge.mockReset();
  deleteAiChallenge.mockReset();
  rotateAiSigningKey.mockReset();
  writeAdminAudit.mockReset();
  allowAdmin();
  listAiChallengesForAdmin.mockResolvedValue([ADMIN_ROW]);
  listAiCategories.mockResolvedValue(["AI"]);
  writeAdminAudit.mockResolvedValue(undefined);
});

describe("GET /api/admin/ai", () => {
  it("403s when requireAdmin refuses, without touching the store", async () => {
    denyAdmin();
    const res = await GET(adminReq("GET"));
    expect(res.status).toBe(403);
    expect(listAiChallengesForAdmin).not.toHaveBeenCalled();
    expect(listAiCategories).not.toHaveBeenCalled();
  });

  it("returns challenges (with secrets) and categories for an admin, one call each", async () => {
    const res = await GET(adminReq("GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenges: [ADMIN_ROW], categories: ["AI"] });
    expect(listAiChallengesForAdmin).toHaveBeenCalledTimes(1);
    expect(listAiCategories).toHaveBeenCalledTimes(1);
  });

  it("503s unavailable when the store throws, and logs neither a flag nor a key", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A driver-decorated error, matching the shape `ai-store.ts`'s own
    // `errorLabel` docstring warns about: the message itself is generic, but
    // the error carries OWN PROPERTIES with the failed command's arguments —
    // exactly what a naive `console.error(err)` would print in full, and
    // what the `errorLabel` (name+message only) discipline must drop.
    const err = new Error("upstash down");
    Object.assign(err, { command: ["HGETALL", "ctf:ai:flag"], args: ["CTF{flag}"], cause: "signkey-abc" });
    listAiChallengesForAdmin.mockRejectedValue(err);
    const res = await GET(adminReq("GET"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });

    // Every logged argument must be a primitive STRING, never the raw error
    // object. This is the assertion that actually distinguishes redacted
    // logging (`errorLabel(err)`, a string) from raw logging
    // (`console.error(..., err)`, an object): `Array.prototype.join` used
    // below stringifies an Error via `Error.prototype.toString()`, which
    // renders only `name: message` and silently drops the object's own
    // enumerable properties — so a `logged.not.toContain(...)` check alone
    // cannot tell the two apart. A `typeof arg === "object"` argument fails
    // here regardless of what its own properties happen to serialize to.
    for (const call of spy.mock.calls) {
      for (const arg of call) {
        expect(typeof arg).toBe("string");
      }
    }
    // Belt-and-suspenders on top of the type check: walk each argument's own
    // properties with `util.inspect` (not `Array.join`/`String()`, which
    // both go through `Error.prototype.toString()` and would miss them) so
    // the no-secret-text check is honest even if a future arg legitimately
    // is an object.
    const logged = spy.mock.calls.map((call) => call.map((arg) => inspect(arg, { depth: 5 })).join(" ")).join("\n");
    expect(logged).not.toContain("CTF{flag}");
    expect(logged).not.toContain("signkey-abc");
    spy.mockRestore();
  });
});

// Finding A (classic parity): the admin POST route dispatches between
// payload shapes by KEY SET ALONE, with no discriminator field. That only
// stays safe as long as EVERY PAIR of the route's shapes' allowed key sets
// is disjoint — not just one hand-picked pair. This test derives all three
// sets from the actual exported constants the route's parsers use
// (`CHALLENGE_KEYS` / `CATEGORIES_KEYS` / `ROTATE_KEYS`) and checks every
// pair among them, so a FOURTH shape added later is covered by adding one
// line to the `sets` list below, rather than a second bespoke assertion — a
// hardcoded pairwise copy would silently miss it. Mirrors
// admin/classic/route.test.ts's "keeps every payload key set pairwise
// disjoint" case exactly.
describe("POST /api/admin/ai — dispatch key sets", () => {
  it("keeps every payload key set pairwise disjoint", () => {
    const sets = [
      ["CHALLENGE_KEYS", CHALLENGE_KEYS],
      ["CATEGORIES_KEYS", CATEGORIES_KEYS],
      ["ROTATE_KEYS", ROTATE_KEYS],
    ] as const;
    for (const [aName, a] of sets) {
      for (const [bName, b] of sets) {
        if (aName === bName) continue;
        const overlap = [...a].filter((k) => b.has(k));
        expect(overlap, `${aName} vs ${bName}`).toEqual([]);
      }
    }
  });
});

describe("POST /api/admin/ai — categories", () => {
  it("403s when requireAdmin refuses, without writing anything", async () => {
    denyAdmin();
    const res = await POST(adminReq("POST", { categories: ["AI"], expected: [] }));
    expect(res.status).toBe(403);
    expect(setAiCategories).not.toHaveBeenCalled();
  });

  it("replaces categories against the list the organizer edited, echoes it, and writes an audit line", async () => {
    setAiCategories.mockResolvedValue(["AI", "Prompt"]);
    const res = await POST(adminReq("POST", { categories: ["AI", "Prompt"], expected: ["AI"] }));
    expect(res.status).toBe(200);
    expect(setAiCategories).toHaveBeenCalledWith(["AI", "Prompt"], ["AI"]);
    expect(await res.json()).toEqual({ categories: ["AI", "Prompt"] });
    expect(writeAdminAudit).toHaveBeenCalledWith("alice", "ai-categories", { count: 2 });
  });

  it("400s a list replace that does not say which list it was edited from", async () => {
    for (const body of [{ categories: ["AI"] }, { categories: ["AI"], expected: "AI" }, { categories: ["AI"], expected: [1] }]) {
      const res = await POST(adminReq("POST", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(setAiCategories).not.toHaveBeenCalled();
  });

  it("maps a validation error to 400 and a store failure to 503", async () => {
    setAiCategories.mockRejectedValue(new AiValidationError("categories", "too many"));
    expect((await POST(adminReq("POST", { categories: ["AI"], expected: [] }))).status).toBe(400);

    setAiCategories.mockRejectedValue(new Error("upstash down"));
    expect((await POST(adminReq("POST", { categories: ["AI"], expected: [] }))).status).toBe(503);
  });

  it("409s a stale edit with a reload-and-retry message, and audits nothing", async () => {
    setAiCategories.mockRejectedValue(new CategoryConflictError());
    const res = await POST(adminReq("POST", { categories: ["AI", "Prompt"], expected: ["AI"] }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: CATEGORY_CONFLICT_MESSAGE });
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/ai — rename a category", () => {
  it("dispatches the rename to the store, reports what moved, and audits it", async () => {
    renameAiCategory.mockResolvedValue({ categories: ["Jailbreak"], moved: 2 });
    const res = await POST(adminReq("POST", { renameCategory: { from: "Jailbreakk", to: "Jailbreak" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ categories: ["Jailbreak"], moved: 2 });
    expect(renameAiCategory).toHaveBeenCalledWith("Jailbreakk", "Jailbreak");
    expect(setAiCategories).not.toHaveBeenCalled();
    expect(writeAdminAudit).toHaveBeenCalledWith("alice", "ai-category-rename", {
      from: "Jailbreakk",
      to: "Jailbreak",
      moved: 2,
    });
  });

  it("409s a rename that kept losing the race, and audits nothing", async () => {
    renameAiCategory.mockRejectedValue(new CategoryConflictError());
    const res = await POST(adminReq("POST", { renameCategory: { from: "Jailbreakk", to: "Jailbreak" } }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: CATEGORY_CONFLICT_MESSAGE });
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/ai — rotate", () => {
  it("403s when requireAdmin refuses, without touching the store", async () => {
    denyAdmin();
    const res = await POST(adminReq("POST", { rotate: "c-1" }));
    expect(res.status).toBe(403);
    expect(rotateAiSigningKey).not.toHaveBeenCalled();
  });

  it("rotates the signing key, returns it, and audits the id but never the key", async () => {
    rotateAiSigningKey.mockResolvedValue("new-key-xyz");
    const res = await POST(adminReq("POST", { rotate: "c-1" }));
    expect(res.status).toBe(200);
    expect(rotateAiSigningKey).toHaveBeenCalledWith("c-1");
    expect(await res.json()).toEqual({ signingKey: "new-key-xyz" });

    expect(writeAdminAudit).toHaveBeenCalledWith("alice", "ai-rotate-key", { id: "c-1" });
    // The new key itself is NEVER in the audit detail — only the id.
    expect(JSON.stringify(writeAdminAudit.mock.calls[0])).not.toContain("new-key-xyz");
  });

  it("maps a validation error to 400 and a store failure to 503", async () => {
    rotateAiSigningKey.mockRejectedValue(new AiValidationError("id", "Unknown challenge: c-1"));
    expect((await POST(adminReq("POST", { rotate: "c-1" }))).status).toBe(400);

    rotateAiSigningKey.mockRejectedValue(new Error("upstash down"));
    expect((await POST(adminReq("POST", { rotate: "c-1" }))).status).toBe(503);
  });
});

describe("POST /api/admin/ai — challenge upsert", () => {
  it("403s when requireAdmin refuses, without writing anything", async () => {
    denyAdmin();
    const res = await POST(adminReq("POST", validPayload));
    expect(res.status).toBe(403);
    expect(upsertAiChallenge).not.toHaveBeenCalled();
  });

  it("400s a body matching none of the three shapes", async () => {
    const res = await POST(adminReq("POST", { nonsense: true }));
    expect(res.status).toBe(400);
    expect(upsertAiChallenge).not.toHaveBeenCalled();
    expect(setAiCategories).not.toHaveBeenCalled();
    expect(rotateAiSigningKey).not.toHaveBeenCalled();
  });

  it("upserts, separates the challenge fields from {flag, hint}, and echoes the AdminAiChallenge", async () => {
    upsertAiChallenge.mockResolvedValue(ADMIN_ROW);
    const res = await POST(adminReq("POST", { ...validPayload, hint: "try harder" }));
    expect(res.status).toBe(200);
    expect(upsertAiChallenge).toHaveBeenCalledWith(CHALLENGE, { flag: "CTF{flag}", hint: "try harder" });
    expect(await res.json()).toEqual(ADMIN_ROW);

    expect(writeAdminAudit).toHaveBeenCalledWith("alice", "ai-upsert", { id: "c-1" });
  });

  it("400s with the message for an AiValidationError from the store", async () => {
    upsertAiChallenge.mockRejectedValue(new AiValidationError("mode", "Unknown mode: bogus"));
    const res = await POST(adminReq("POST", validPayload));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown mode: bogus" });
  });

  it("503s unavailable on a store failure, not 400", async () => {
    upsertAiChallenge.mockRejectedValue(new Error("upstash down"));
    const res = await POST(adminReq("POST", validPayload));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("rejects a payload carrying an unknown key", async () => {
    const res = await POST(adminReq("POST", { ...validPayload, sneaky: 1 }));
    expect(res.status).toBe(400);
    expect(upsertAiChallenge).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/ai", () => {
  it("403s when requireAdmin refuses, without deleting anything", async () => {
    denyAdmin();
    const res = await DELETE(adminReq("DELETE", { id: "c-1" }));
    expect(res.status).toBe(403);
    expect(deleteAiChallenge).not.toHaveBeenCalled();
  });

  it("400s a missing id, without deleting anything", async () => {
    const res = await DELETE(adminReq("DELETE", {}));
    expect(res.status).toBe(400);
    expect(deleteAiChallenge).not.toHaveBeenCalled();
  });

  it("deletes the challenge and writes an audit line with the id", async () => {
    deleteAiChallenge.mockResolvedValue(undefined);
    const res = await DELETE(adminReq("DELETE", { id: "c-1" }));
    expect(res.status).toBe(200);
    expect(deleteAiChallenge).toHaveBeenCalledWith("c-1");
    expect(writeAdminAudit).toHaveBeenCalledWith("alice", "ai-delete", { id: "c-1" });
  });

  it("400s with the message for an AiValidationError from the store", async () => {
    deleteAiChallenge.mockRejectedValue(new AiValidationError("id", "Invalid challenge id: ../etc"));
    const res = await DELETE(adminReq("DELETE", { id: "../etc" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid challenge id: ../etc" });
  });

  it("503s unavailable, not 400, when the store fails for an infra reason", async () => {
    deleteAiChallenge.mockRejectedValue(new Error("Upstash HDEL failed: timeout"));
    const res = await DELETE(adminReq("DELETE", { id: "c-1" }));
    expect(res.status).toBe(503);
  });
});
