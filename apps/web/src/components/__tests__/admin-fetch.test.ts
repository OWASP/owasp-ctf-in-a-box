// The one JSON transport the three module admin panels share
// (admin-quiz-controls, admin-classic-controls, admin-ai-controls). Each used
// to carry its own `parseJson`, its own `describeXError` and its own
// try/fetch/catch around every POST and DELETE; these tests pin the exact
// messages those copies produced so the extraction changes nothing an
// organizer reads.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK_ERROR, describeAdminError, parseJson, sendJson } from "@/components/admin/fetch";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("parseJson", () => {
  it("returns the parsed body", async () => {
    await expect(parseJson<{ a: number }>(jsonResponse(200, { a: 1 }))).resolves.toEqual({ a: 1 });
  });

  it("returns an empty object for a body that is not JSON, never throwing", async () => {
    const res = new Response("<html>gateway timeout</html>", { status: 504 });
    await expect(parseJson(res)).resolves.toEqual({});
  });
});

describe("describeAdminError", () => {
  const fallback = "That didn't work — check the challenge and try again.";

  it("surfaces a 400 validation error as the store's own message", () => {
    expect(describeAdminError(400, "points must be an integer", fallback)).toBe("points must be an integer");
  });

  it("falls back to the module's sentence when a non-503 reply carries no message", () => {
    expect(describeAdminError(400, undefined, fallback)).toBe(fallback);
  });

  it("surfaces a 503 infrastructure failure distinctly from a validation error", () => {
    expect(describeAdminError(503, "redis down", fallback)).toBe("Store unavailable — redis down");
    expect(describeAdminError(503, undefined, fallback)).toBe("Store unavailable — try again shortly.");
  });
});

describe("sendJson", () => {
  const describe503 = (status: number, message?: string) => describeAdminError(status, message, "fallback");

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the method, JSON content type and serialized body exactly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { challenge: { id: "x" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendJson<{ challenge?: { id: string } }>("/api/admin/classic", { method: "DELETE", body: { id: "x" } }, describe503);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/classic", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "x" }),
    });
    expect(result).toEqual({ ok: true, status: 200, data: { challenge: { id: "x" } } });
  });

  it("returns the described error for a non-2xx reply, with the reply's status", async () => {
    // The status rides along so a caller can act on one refusal in
    // particular — the category editor re-reads its lists on a 409.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad flag" })));
    await expect(sendJson("/api/admin/ai", { method: "POST", body: {} }, describe503)).resolves.toEqual({
      ok: false,
      message: "bad flag",
      status: 400,
    });
  });

  it("turns a network failure into the shared can't-reach sentence", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(sendJson("/api/admin/quiz", { method: "POST", body: {} }, describe503)).resolves.toEqual({
      ok: false,
      message: NETWORK_ERROR,
    });
    expect(NETWORK_ERROR).toBe("Couldn't reach the server — try again.");
  });
});
