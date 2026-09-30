// Unit tests for the live challenge catalogue: grouping the flat API list by
// app, and the fetch wrapper's degrade-to-null behavior (missing env, HTTP
// errors, malformed bodies) that keeps the challenges page on its static
// fallback instead of crashing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getChallengeCatalog, groupCatalog, type CatalogChallenge } from "@/lib/challenges";
import type { AppId } from "@/lib/apps";
import { decoratedError, expectLabelOnly } from "./log-redaction";

/** One challenge in the shape the SCORER sends: a rubric `name`, and `owasp`
 *  as a bare code (or null). Resolving that code into a label and a link is
 *  this module's job, not the wire's. */
function wire(app: AppId, id: string, owasp: string | null = "A01") {
  return { app, id, name: id.replace(/-/g, " "), points: 10, owasp };
}

describe("groupCatalog", () => {
  it("groups the flat list by app and preserves order within each app", () => {
    const challenges = [
      wire("juice-shop", "Challenge-1"),
      wire("dvwa", "brute-low"),
      wire("juice-shop", "Challenge-2"),
    ];
    const catalog = groupCatalog({ challenges, counts: {}, total: 3 });
    expect(catalog.byApp["juice-shop"]?.map((c) => c.id)).toEqual(["Challenge-1", "Challenge-2"]);
    expect(catalog.byApp.dvwa).toHaveLength(1);
    expect(catalog.byApp.webgoat).toBeUndefined();
  });

  it("derives total from the list itself, not the reported fields", () => {
    const challenges = [wire("vampi", "a"), wire("vampi", "b")];
    const catalog = groupCatalog({ challenges, counts: { vampi: 99 }, total: 99 });
    expect(catalog.total).toBe(2);
  });

  // The wire carries a rubric `name` and a bare category code; the UI renders
  // a `description` and a code/label/link triple. Resolving that here is what
  // keeps OWASP's taxonomy out of the scorer.
  it("resolves the wire shape into what the UI renders", () => {
    const catalog = groupCatalog({ challenges: [wire("dvwa", "sqli-low", "A03")], counts: {}, total: 1 });
    const c = catalog.byApp.dvwa![0] as CatalogChallenge;
    expect(c.description).toBe("sqli low");
    expect(c.points).toBe(10);
    expect(c.owasp).toEqual({
      code: "A03",
      label: "Injection",
      url: "https://owasp.org/Top10/A03_2021-Injection/",
    });
  });

  // A rubric challenge may legitimately carry no category — every declarative
  // (`<target>.yaml`) rubric does, since that grammar has no owasp field.
  it("omits the category entirely when the rubric has none", () => {
    const catalog = groupCatalog({ challenges: [wire("dvwa", "x", null)], counts: {}, total: 1 });
    expect((catalog.byApp.dvwa![0] as CatalogChallenge).owasp).toBeUndefined();
  });

  // An unmapped code is still real catalogue data. Showing it unlinked beats
  // hiding it behind a gap in this build's mapping.
  it("keeps an unrecognised code, unlinked, rather than dropping it", () => {
    const catalog = groupCatalog({ challenges: [wire("dvwa", "x", "Z99")], counts: {}, total: 1 });
    expect((catalog.byApp.dvwa![0] as CatalogChallenge).owasp).toEqual({
      code: "Z99",
      label: "Z99",
      url: null,
    });
  });
});

describe("getChallengeCatalog", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("LEADERBOARD_API_URL", "https://api.example.test");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  it("fetches /challenges off the leaderboard API base (trailing slash trimmed)", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "https://api.example.test/");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ challenges: [wire("dvwa", "brute-low")], counts: {}, total: 1 })),
    );
    const catalog = await getChallengeCatalog();
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.test/challenges", expect.anything());
    expect(catalog?.total).toBe(1);
    expect(catalog?.byApp.dvwa?.[0].id).toBe("brute-low");
  });

  it("returns null when LEADERBOARD_API_URL is not set (mock mode)", async () => {
    vi.stubEnv("LEADERBOARD_API_URL", "");
    expect(await getChallengeCatalog()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on HTTP errors instead of throwing", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));
    expect(await getChallengeCatalog()).toBeNull();
  });

  it("returns null when the body has no challenge list", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ challenges: [], counts: {}, total: 0 })));
    expect(await getChallengeCatalog()).toBeNull();
  });

  it("returns null when fetch itself rejects", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await getChallengeCatalog()).toBeNull();
  });

  // undici decorates a failed fetch with a `cause` that can carry the request;
  // the log gets the label only (#500 follow-up).
  it("logs the label, not the rejected error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fetchMock.mockRejectedValueOnce(decoratedError("network down"));
      expect(await getChallengeCatalog()).toBeNull();
      expectLabelOnly(consoleError, { label: "network down" });
    } finally {
      consoleError.mockRestore();
    }
  });
});
