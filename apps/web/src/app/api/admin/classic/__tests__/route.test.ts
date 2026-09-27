// Route-level tests for the classic (flag) module's organizer authoring
// route. Auth guard, classic-store, and the shared admin-store audit/error
// helpers (`writeAdminAudit`/`adminErrorLabel` — see admin-store.ts) are all
// mocked — no Redis or GitHub session needed.
//
// requireAdmin must run BEFORE any store read/write in every handler: the
// admin payload carries flags, so an early read on an unauthenticated
// request is not merely wasted work, it is the leak itself. The mutation
// check below (moving requireAdmin after the store read) is what proves the
// "checks requireAdmin BEFORE any store read" test actually enforces that,
// rather than merely looking like it does.

import { inspect } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireAdmin,
  listChallengesForAdmin,
  listCategories,
  setCategories,
  upsertChallenge,
  deleteChallenge,
  importBundle,
  renameCategory,
  listStories,
  setStories,
  listChallengeIds,
  writeAdminAudit,
  ClassicValidationError,
} = vi.hoisted(() => {
  // A real (not mocked) ClassicValidationError, so `err instanceof
  // ClassicValidationError` in the route sees the exact same class the test
  // constructs errors with — that's what makes the 400-vs-503 split testable
  // at all.
  class ClassicValidationError extends Error {
    field: string;
    constructor(field: string, message: string) {
      super(message);
      this.name = "ClassicValidationError";
      this.field = field;
    }
  }
  return {
    requireAdmin: vi.fn(),
    listChallengesForAdmin: vi.fn(),
    listCategories: vi.fn(),
    setCategories: vi.fn(),
    upsertChallenge: vi.fn(),
    deleteChallenge: vi.fn(),
    importBundle: vi.fn(),
    renameCategory: vi.fn(),
    listStories: vi.fn(),
    setStories: vi.fn(),
    listChallengeIds: vi.fn(),
    writeAdminAudit: vi.fn(),
    ClassicValidationError,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin }));
vi.mock("@/lib/classic-store", () => ({
  listChallengesForAdmin,
  listCategories,
  setCategories,
  upsertChallenge,
  deleteChallenge,
  importBundle,
  renameCategory,
  listStories,
  setStories,
  listChallengeIds,
  ClassicValidationError,
}));
// `adminErrorLabel` is the real (name+message, capped) implementation, not a
// mock — the redaction assertion below needs it to actually behave like
// admin-store.ts's real one, dropping any own properties a driver decorated
// the thrown error with.
vi.mock("@/lib/admin-store", () => ({
  writeAdminAudit,
  adminErrorLabel: (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "non-Error throw"),
}));

// classic-io's parseBundle is deliberately NOT mocked: the whole point of the
// import route is that it re-validates the raw text server-side with the
// REAL parser, so a test that mocked parseBundle away could not tell a route
// that actually re-validates from one that just trusts the client.
import {
  GET,
  POST,
  DELETE,
  CHALLENGE_KEYS,
  CATEGORIES_KEYS,
  IMPORT_KEYS,
  RENAME_CATEGORY_KEYS,
  STORIES_KEYS,
} from "@/app/api/admin/classic/route";

const adminReq = (method: "GET" | "POST" | "DELETE", body?: unknown) =>
  new Request("http://x/api/admin/classic", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const CHALLENGE = {
  id: "c-1",
  title: "SQLi 101",
  category: "Web",
  description: "Find the flag.",
  points: 50,
  order: 1,
};

const validPayload = { ...CHALLENGE, flag: "CTF{flag}" };

const ADMIN_ROW = { challenge: CHALLENGE, flag: "CTF{flag}", hint: null };

function allowAdmin() {
  requireAdmin.mockResolvedValue({ ok: true, login: "alice" });
}

function denyAdmin() {
  requireAdmin.mockResolvedValue({ ok: false, status: 403 });
}

function upsertThrows(err: unknown) {
  upsertChallenge.mockRejectedValue(err);
}

beforeEach(() => {
  requireAdmin.mockReset();
  listChallengesForAdmin.mockReset();
  listCategories.mockReset();
  setCategories.mockReset();
  upsertChallenge.mockReset();
  deleteChallenge.mockReset();
  importBundle.mockReset();
  renameCategory.mockReset();
  listStories.mockReset();
  setStories.mockReset();
  listChallengeIds.mockReset();
  writeAdminAudit.mockReset();
  listStories.mockResolvedValue([]);
  listChallengeIds.mockResolvedValue(new Set(["c-1", "c-2"]));
  allowAdmin();
  listChallengesForAdmin.mockResolvedValue([ADMIN_ROW]);
  listCategories.mockResolvedValue(["Web"]);
  writeAdminAudit.mockResolvedValue(undefined);
});

describe("GET /api/admin/classic", () => {
  it("checks requireAdmin BEFORE any store read", async () => {
    denyAdmin();
    const res = await GET(adminReq("GET"));
    expect(res.status).toBe(403);
    // The payload carries flags, so an early read on an unauthenticated
    // request is not merely wasted work.
    expect(listChallengesForAdmin).not.toHaveBeenCalled();
    expect(listCategories).not.toHaveBeenCalled();
  });

  it("401s for no session, with no flag data in the response", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 401 });
    const res = await GET(adminReq("GET"));
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain("CTF{flag}");
  });

  it("returns challenges (with flags) and categories for an admin", async () => {
    const res = await GET(adminReq("GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenges: [ADMIN_ROW], categories: ["Web"], stories: [] });
  });

  // Finding B: the store reads were not wrapped in a try/catch, so a
  // rejection here became an unhandled rejection instead of the clean 503
  // the write paths already get via `errorResponse`. Each list function is
  // rejected in turn so a fix that only guards one of the two calls (e.g.
  // `Promise.all` wrapped, but only the FIRST leg awaited defensively) can't
  // pass by accident.
  it("503s (not throw) when listChallengesForAdmin rejects", async () => {
    listChallengesForAdmin.mockRejectedValue(new Error("upstash down"));
    const res = await GET(adminReq("GET"));
    expect(res.status).toBe(503);
  });

  it("503s (not throw) when listCategories rejects", async () => {
    listCategories.mockRejectedValue(new Error("upstash down"));
    const res = await GET(adminReq("GET"));
    expect(res.status).toBe(503);
  });

  it("503s and logs neither a flag nor any other own property of the thrown error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A driver-decorated error, matching the shape `adminErrorLabel`'s own
    // docstring warns about: the message itself is generic, but the error
    // carries OWN PROPERTIES with the failed command's arguments — exactly
    // what a naive `console.error(err)` would print in full, and what the
    // name+message-only discipline must drop.
    const err = new Error("upstash down");
    Object.assign(err, { command: ["HGETALL", "ctf:classic:flag"], args: ["CTF{flag}"] });
    listChallengesForAdmin.mockRejectedValue(err);
    const res = await GET(adminReq("GET"));
    expect(res.status).toBe(503);

    // Every logged argument must be a primitive STRING, never the raw error
    // object — see ai/route.test.ts's equivalent case for why this, rather
    // than a `logged.not.toContain(...)` string check alone, is what
    // actually distinguishes redacted logging from raw logging.
    for (const call of spy.mock.calls) {
      for (const arg of call) {
        expect(typeof arg).toBe("string");
      }
    }
    const logged = spy.mock.calls.map((call) => call.map((arg) => inspect(arg, { depth: 5 })).join(" ")).join("\n");
    expect(logged).not.toContain("CTF{flag}");
    spy.mockRestore();
  });
});

// Finding A: the admin POST route dispatches between payload shapes by KEY
// SET ALONE, with no discriminator field. That only stays safe as long as
// EVERY PAIR of the route's shapes' allowed key sets is disjoint — not just
// one hand-picked pair. This test derives all three sets from the actual
// exported constants the route's parsers use (`CHALLENGE_KEYS` /
// `CATEGORIES_KEYS` / `IMPORT_KEYS` / `RENAME_CATEGORY_KEYS`) and checks every
// pair among them, so a shape added later is covered by adding one line to the
// `sets` list below, rather than a second bespoke assertion — a hardcoded
// pairwise copy would silently miss it. The fourth shape arrived with #304 and
// did exactly that.
describe("POST /api/admin/classic — dispatch key sets", () => {
  it("keeps every payload key set pairwise disjoint", () => {
    const sets = [
      ["CHALLENGE_KEYS", CHALLENGE_KEYS],
      ["CATEGORIES_KEYS", CATEGORIES_KEYS],
      ["IMPORT_KEYS", IMPORT_KEYS],
      // The fourth shape (#304). This is the "one line" the note above
      // promised; RENAME_FIELD_KEYS is deliberately absent because it names
      // the INNER object's keys, which never take part in outer dispatch.
      ["RENAME_CATEGORY_KEYS", RENAME_CATEGORY_KEYS],
      // The fifth shape (#463).
      ["STORIES_KEYS", STORIES_KEYS],
    ] as const;
    for (const [aName, a] of sets) {
      for (const [bName, b] of sets) {
        if (aName === bName) continue;
        const overlap = [...a].filter((k) => b.has(k));
        expect(overlap, `${aName} vs ${bName}`).toEqual([]);
      }
    }
  });

  it("400s a body that matches neither shape", async () => {
    const res = await POST(adminReq("POST", { nonsense: true }));
    expect(res.status).toBe(400);
    expect(upsertChallenge).not.toHaveBeenCalled();
    expect(setCategories).not.toHaveBeenCalled();
  });

  it("rejects a body carrying BOTH a categories key and challenge keys, rather than silently picking one", async () => {
    const res = await POST(adminReq("POST", { ...validPayload, categories: ["Web"] }));
    expect(res.status).toBe(400);
    expect(upsertChallenge).not.toHaveBeenCalled();
    expect(setCategories).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/classic — challenge upsert", () => {
  it("401s for no session, without writing anything", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 401 });
    const res = await POST(adminReq("POST", validPayload));
    expect(res.status).toBe(401);
    expect(upsertChallenge).not.toHaveBeenCalled();
  });

  it("403s for a non-admin, without writing anything", async () => {
    denyAdmin();
    const res = await POST(adminReq("POST", validPayload));
    expect(res.status).toBe(403);
    expect(upsertChallenge).not.toHaveBeenCalled();
  });

  it("rejects a payload carrying an unknown key", async () => {
    const res = await POST(adminReq("POST", { ...validPayload, sneaky: 1 }));
    expect(res.status).toBe(400);
    expect(upsertChallenge).not.toHaveBeenCalled();
  });

  it("400s a non-integer points value", async () => {
    const res = await POST(adminReq("POST", { ...validPayload, points: 1.5 }));
    expect(res.status).toBe(400);
    expect(upsertChallenge).not.toHaveBeenCalled();
  });

  it("400s a whitespace-only title", async () => {
    upsertChallenge.mockResolvedValue(ADMIN_ROW);
    const res = await POST(adminReq("POST", { ...validPayload, title: "   " }));
    expect(res.status).toBe(400);
    expect(upsertChallenge).not.toHaveBeenCalled();
  });

  it("400s an empty flag", async () => {
    const res = await POST(adminReq("POST", { ...validPayload, flag: "" }));
    expect(res.status).toBe(400);
    expect(upsertChallenge).not.toHaveBeenCalled();
  });

  it("maps a validation error to 400 and a store failure to 503", async () => {
    upsertThrows(new ClassicValidationError("points", "bad"));
    expect((await POST(adminReq("POST", validPayload))).status).toBe(400);

    upsertThrows(new Error("upstash down"));
    expect((await POST(adminReq("POST", validPayload))).status).toBe(503);
  });

  it("400s with the message and field for a ClassicValidationError", async () => {
    upsertThrows(new ClassicValidationError("category", "Unknown category: Nope"));
    const res = await POST(adminReq("POST", validPayload));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Unknown category: Nope", field: "category" });
  });

  it("upserts, echoes the stored record, and writes an audit line", async () => {
    upsertChallenge.mockResolvedValue(ADMIN_ROW);
    const res = await POST(adminReq("POST", validPayload));
    expect(res.status).toBe(200);
    // A payload without a hint passes `undefined` through — the store leaves
    // the hint row alone only via an explicit empty string, never a default.
    expect(upsertChallenge).toHaveBeenCalledWith(CHALLENGE, "CTF{flag}", undefined);
    expect(await res.json()).toEqual({ challenge: CHALLENGE, flag: "CTF{flag}", hint: null });

    expect(writeAdminAudit).toHaveBeenCalledWith("alice", "classic-upsert", { challengeId: "c-1" });
  });
});

describe("POST /api/admin/classic — categories", () => {
  it("401s for no session, without writing anything", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 401 });
    const res = await POST(adminReq("POST", { categories: ["Web"] }));
    expect(res.status).toBe(401);
    expect(setCategories).not.toHaveBeenCalled();
  });

  it("400s a categories array with a non-string entry", async () => {
    const res = await POST(adminReq("POST", { categories: ["Web", 1] }));
    expect(res.status).toBe(400);
    expect(setCategories).not.toHaveBeenCalled();
  });

  it("maps a validation error to 400 and a store failure to 503", async () => {
    setCategories.mockRejectedValue(new ClassicValidationError("categories", "too many"));
    expect((await POST(adminReq("POST", { categories: ["Web"] }))).status).toBe(400);

    setCategories.mockRejectedValue(new Error("upstash down"));
    expect((await POST(adminReq("POST", { categories: ["Web"] }))).status).toBe(503);
  });

  it("replaces categories, echoes the stored list, and writes an audit line", async () => {
    setCategories.mockResolvedValue(["Web", "Crypto"]);
    const res = await POST(adminReq("POST", { categories: ["Web", "Crypto"] }));
    expect(res.status).toBe(200);
    expect(setCategories).toHaveBeenCalledWith(["Web", "Crypto"]);
    expect(await res.json()).toEqual({ categories: ["Web", "Crypto"] });
    expect(writeAdminAudit).toHaveBeenCalledWith("alice", "classic-categories", { count: 2 });
  });
});

const validBundle = {
  version: 1,
  categories: ["Web", "Crypto"],
  challenges: [
    { id: "web-one-ab12cd", title: "One", category: "Web", description: "**find it**", points: 50, order: 0, flag: "ctfbox{One}" },
    { id: "crypto-two-ef34gh", title: "Two", category: "Crypto", description: "look `here`", points: 100, order: 0, flag: "ctfbox{Two}" },
  ],
};

// Deliberately wrong in MULTIPLE independent ways (bad id shape, missing
// title, unknown category, negative points, empty flag) so a route that
// truncated to the first parseBundle error, rather than returning the whole
// list, would still show a suspiciously short `errors` array here.
const badBundle = {
  version: 1,
  categories: [],
  challenges: [{ id: "x!", title: "", category: "Nope", description: "", points: -1, order: 0, flag: "" }],
};

describe("POST /api/admin/classic — import", () => {
  it("401s for no session, without parsing or importing anything", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 401 });
    const res = await POST(adminReq("POST", { import: JSON.stringify(validBundle) }));
    expect(res.status).toBe(401);
    expect(importBundle).not.toHaveBeenCalled();
  });

  it("checks requireAdmin before parsing or importing", async () => {
    denyAdmin();
    const res = await POST(adminReq("POST", { import: JSON.stringify(validBundle) }));
    expect(res.status).toBe(403);
    expect(importBundle).not.toHaveBeenCalled();
  });

  it("imports a valid bundle and reports what changed", async () => {
    importBundle.mockResolvedValue({ created: 2, updated: 0, categories: 2 });
    const res = await POST(adminReq("POST", { import: JSON.stringify(validBundle) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 2, updated: 0, categories: 2 });
    expect(importBundle).toHaveBeenCalledWith(validBundle);
  });

  it("400s an invalid bundle and returns EVERY error, writing nothing", async () => {
    const res = await POST(adminReq("POST", { import: JSON.stringify(badBundle) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.length).toBeGreaterThan(1);
    expect(importBundle).not.toHaveBeenCalled();
  });

  // The whole reason the route accepts raw TEXT rather than a pre-parsed
  // bundle: this payload is shaped exactly like a bundle object (right
  // top-level keys, an array of "challenges") but every field inside is
  // invalid. A route that skipped its own `parseBundle` call and forwarded
  // the client's object straight to `importBundle` would let this through.
  it("re-validates server-side even if the client sent something shaped right", async () => {
    const res = await POST(
      adminReq("POST", {
        import: JSON.stringify({
          version: 1,
          categories: [],
          challenges: [{ id: "x!", title: "", category: "Nope", description: "", points: -1, order: 0, flag: "" }],
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(importBundle).not.toHaveBeenCalled();
  });

  it("400s malformed JSON in the import string", async () => {
    const res = await POST(adminReq("POST", { import: "{not json" }));
    expect(res.status).toBe(400);
    expect(importBundle).not.toHaveBeenCalled();
  });

  it("maps a store failure to 503, not 400", async () => {
    importBundle.mockRejectedValue(new Error("upstash down"));
    const res = await POST(adminReq("POST", { import: JSON.stringify(validBundle) }));
    expect(res.status).toBe(503);
  });

  it("imports and writes an audit line recording the counts", async () => {
    importBundle.mockResolvedValue({ created: 2, updated: 0, categories: 2 });
    await POST(adminReq("POST", { import: JSON.stringify(validBundle) }));
    expect(writeAdminAudit).toHaveBeenCalledWith("alice", "classic-import", { created: 2, updated: 0, categories: 2 });
  });
});

// #463: the story authoring shape — exactly `{ stories }`, the whole list.
describe("POST /api/admin/classic — stories", () => {
  const STORY = { id: "op", title: "Operation", intro: "", steps: ["c-1", "c-2"] };

  it("checks requireAdmin before reading or writing anything", async () => {
    denyAdmin();
    const res = await POST(adminReq("POST", { stories: [STORY] }));
    expect(res.status).toBe(403);
    expect(listChallengeIds).not.toHaveBeenCalled();
    expect(setStories).not.toHaveBeenCalled();
  });

  it("replaces the list, echoes what was stored, and writes an audit line", async () => {
    setStories.mockResolvedValue([STORY]);
    const res = await POST(adminReq("POST", { stories: [STORY] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stories: [STORY] });
    expect(setStories).toHaveBeenCalledWith([STORY]);
    expect(writeAdminAudit).toHaveBeenCalledWith("alice", "classic-stories", { count: 1 });
  });

  it("400s a step naming a challenge that does not exist, without writing", async () => {
    const res = await POST(adminReq("POST", { stories: [{ ...STORY, steps: ["c-1", "ghost-zz99zz"] }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ghost-zz99zz/);
    expect(setStories).not.toHaveBeenCalled();
  });

  it("400s a non-array and a body carrying another key too", async () => {
    expect((await POST(adminReq("POST", { stories: "op" }))).status).toBe(400);
    expect((await POST(adminReq("POST", { stories: [STORY], categories: ["Web"] }))).status).toBe(400);
    expect(setStories).not.toHaveBeenCalled();
    expect(setCategories).not.toHaveBeenCalled();
  });

  it("maps a store validation error to 400 and a read failure to 503", async () => {
    setStories.mockRejectedValue(new ClassicValidationError("stories", "c-1 is in two stories"));
    expect((await POST(adminReq("POST", { stories: [STORY] }))).status).toBe(400);
    listChallengeIds.mockRejectedValue(new Error("upstash down"));
    expect((await POST(adminReq("POST", { stories: [STORY] }))).status).toBe(503);
  });
});

describe("DELETE /api/admin/classic", () => {
  it("401s for no session, without deleting anything", async () => {
    requireAdmin.mockResolvedValue({ ok: false, status: 401 });
    const res = await DELETE(adminReq("DELETE", { id: "c-1" }));
    expect(res.status).toBe(401);
    expect(deleteChallenge).not.toHaveBeenCalled();
  });

  it("403s for a non-admin, without deleting anything", async () => {
    denyAdmin();
    const res = await DELETE(adminReq("DELETE", { id: "c-1" }));
    expect(res.status).toBe(403);
    expect(deleteChallenge).not.toHaveBeenCalled();
  });

  it("400s a missing id", async () => {
    const res = await DELETE(adminReq("DELETE", {}));
    expect(res.status).toBe(400);
    expect(deleteChallenge).not.toHaveBeenCalled();
  });

  it("deletes the challenge and writes an audit line", async () => {
    deleteChallenge.mockResolvedValue(undefined);
    const res = await DELETE(adminReq("DELETE", { id: "c-1" }));
    expect(res.status).toBe(200);
    expect(deleteChallenge).toHaveBeenCalledWith("c-1");
    expect(writeAdminAudit).toHaveBeenCalledWith("alice", "classic-delete", { challengeId: "c-1" });
  });

  it("400s with the message for a ClassicValidationError from the store", async () => {
    deleteChallenge.mockRejectedValue(new ClassicValidationError("id", "Invalid challenge id: ../etc"));
    const res = await DELETE(adminReq("DELETE", { id: "../etc" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid challenge id: ../etc", field: "id" });
  });

  it("503s, not 400, when the store fails for an infra reason", async () => {
    deleteChallenge.mockRejectedValue(new Error("Upstash HDEL failed: timeout"));
    const res = await DELETE(adminReq("DELETE", { id: "c-1" }));
    expect(res.status).toBe(503);
  });
});

// #304: renaming a category is its own POST shape, because the `categories`
// array cannot express one — a renamed entry is indistinguishable from "one
// removed, one added", which is exactly how the challenges lost their
// association with it.
describe("POST /api/admin/classic — rename a category", () => {
  it("dispatches the rename shape to the store and reports what moved", async () => {
    renameCategory.mockResolvedValue({ categories: ["Web", "Crypto"], moved: 3 });
    const res = await POST(adminReq("POST", { renameCategory: { from: "Webb", to: "Web" } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ categories: ["Web", "Crypto"], moved: 3 });
    expect(renameCategory).toHaveBeenCalledWith("Webb", "Web");
    // The rename must never be mistaken for a whole-list replace.
    expect(setCategories).not.toHaveBeenCalled();
    expect(upsertChallenge).not.toHaveBeenCalled();
  });

  it("audits the rename with both names and the count carried across", async () => {
    renameCategory.mockResolvedValue({ categories: ["Web"], moved: 2 });
    await POST(adminReq("POST", { renameCategory: { from: "Webb", to: "Web" } }));
    expect(writeAdminAudit).toHaveBeenCalledWith("alice", "classic-category-rename", {
      from: "Webb",
      to: "Web",
      moved: 2,
    });
  });

  it("400s a rename body carrying anything extra, inside or out", async () => {
    // The nested object is key-checked too: a body smuggling a field past the
    // outer check must not be partly honoured.
    for (const body of [
      { renameCategory: { from: "a", to: "b" }, categories: ["x"] },
      { renameCategory: { from: "a", to: "b", extra: 1 } },
      { renameCategory: { from: "a" } },
      { renameCategory: { from: 1, to: "b" } },
      { renameCategory: "Web" },
    ]) {
      const res = await POST(adminReq("POST", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(renameCategory).not.toHaveBeenCalled();
  });

  it("passes a store refusal through as a 400, not a 503", async () => {
    // A collision is the organizer's to fix, so it must not read as the store
    // being down.
    renameCategory.mockRejectedValue(new ClassicValidationError("categories", '"Web" already exists.'));
    const res = await POST(adminReq("POST", { renameCategory: { from: "Crypto", to: "Web" } }));
    expect(res.status).toBe(400);
  });
});
