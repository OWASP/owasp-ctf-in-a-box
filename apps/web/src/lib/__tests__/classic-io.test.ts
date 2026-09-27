import { describe, expect, it } from "vitest";
import { parseBundle, serializeBundle, type ClassicBundle } from "@/lib/classic-io";

const valid: ClassicBundle = {
  version: 1,
  categories: ["Web", "Crypto"],
  challenges: [
    { id: "web-one-ab12cd", title: "One", category: "Web", description: "**find it**", points: 50, order: 0, flag: "ctfbox{One}" },
    { id: "crypto-two-ef34gh", title: "Two", category: "Crypto", description: "look `here`", points: 100, order: 0, flag: "ctfbox{Two}" },
  ],
};

describe("parseBundle", () => {
  it("accepts a well-formed bundle", () => {
    const res = parseBundle(JSON.stringify(valid));
    expect(res).toEqual({ ok: true, bundle: valid });
  });

  it("round-trips its own serialization", () => {
    const res = parseBundle(serializeBundle(valid));
    if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res.errors)}`);
    expect(res.bundle).toEqual(valid);
  });

  it("reports malformed JSON as one error, not a crash", () => {
    const res = parseBundle("{not json");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].where).toBe("(document)");
  });

  it("rejects an unknown version rather than misparsing it", () => {
    // 2 is a real version since #463 (stories); 3 is not.
    const res = parseBundle(JSON.stringify({ ...valid, version: 3 }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors.some((e) => e.where === "version")).toBe(true);
  });

  // The whole point of the error shape: one paste, every problem.
  it("collects EVERY error rather than stopping at the first", () => {
    const bad = {
      version: 1,
      categories: ["Web"],
      challenges: [
        { id: "bad id!", title: "", category: "Web", description: "x", points: 1.5, order: 0, flag: "f" },
        { id: "ok-ab12cd", title: "T", category: "Nope", description: "x", points: 10, order: 0, flag: "  " },
      ],
    };
    const res = parseBundle(JSON.stringify(bad));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    const wheres = res.errors.map((e) => e.where);
    expect(wheres).toContain("challenges[0].id");
    expect(wheres).toContain("challenges[0].title");
    expect(wheres).toContain("challenges[0].points");
    expect(wheres).toContain("challenges[1].category");
    expect(wheres).toContain("challenges[1].flag");
  });

  it("rejects duplicate ids within one file", () => {
    const dup = { ...valid, challenges: [valid.challenges[0], { ...valid.challenges[0], title: "Other" }] };
    const res = parseBundle(JSON.stringify(dup));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors.some((e) => /duplicate/i.test(e.message))).toBe(true);
  });

  // A bundle must be self-contained: importing it must not depend on
  // categories that happen to already exist in the target store.
  it("rejects a challenge whose category is not in the file's own categories", () => {
    const orphan = { ...valid, categories: ["Web"], challenges: [valid.challenges[1]] };
    const res = parseBundle(JSON.stringify(orphan));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors.some((e) => e.where === "challenges[0].category")).toBe(true);
  });

  it("rejects an unknown key on a challenge", () => {
    const extra = { ...valid, challenges: [{ ...valid.challenges[0], sneaky: 1 }] };
    const res = parseBundle(JSON.stringify(extra));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors.some((e) => /unknown key/i.test(e.message))).toBe(true);
  });

  it("rejects a top-level shape that is not an object with a challenges array", () => {
    for (const bad of ["[]", "null", "42", JSON.stringify({ version: 1, categories: [] })]) {
      expect(parseBundle(bad).ok, bad).toBe(false);
    }
  });
});

describe("serializeBundle", () => {
  it("emits stable, human-editable JSON ending in a newline", () => {
    const text = serializeBundle(valid);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"version": 1');
    // Indented, not minified — an organizer edits this by hand.
    expect(text).toContain("\n  ");
  });
});

// Case-sensitive flags across the bundle boundary (issue #193).
/** `valid` with the given extra fields merged onto its FIRST challenge. */
function withFirstChallenge(extra: Record<string, unknown>): string {
  const [first, ...rest] = valid.challenges;
  return JSON.stringify({ ...valid, challenges: [{ ...first, ...extra }, ...rest] });
}

describe("caseSensitive in a bundle", () => {
  it("accepts the field and refuses a non-boolean", () => {
    // A hand-edited bundle is the realistic source of `"caseSensitive": "true"`,
    // and a truthy string would silently make a challenge case-sensitive that
    // its author did not mean to.
    const ok = parseBundle(withFirstChallenge({ caseSensitive: true }));
    expect(ok.ok).toBe(true);

    const bad = parseBundle(withFirstChallenge({ caseSensitive: "true" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.some((e) => e.where.endsWith(".caseSensitive"))).toBe(true);
  });

  it("still accepts a bundle exported before the field existed", () => {
    // The contract of a versioned bundle: an older export must keep importing.
    expect(parseBundle(withFirstChallenge({})).ok).toBe(true);
  });
});

describe("bundle v2: stories (#463)", () => {
  const ids = valid.challenges.map((c) => c.id);
  const v2 = (stories: unknown) => JSON.stringify({ ...valid, version: 2, stories });

  it("accepts a v2 bundle with stories, and a v1 bundle without", () => {
    const res = parseBundle(v2([{ id: "op", title: "Op", intro: "Go.", steps: ids }]));
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.bundle.stories).toEqual([{ id: "op", title: "Op", intro: "Go.", steps: ids }]);
    expect(parseBundle(JSON.stringify(valid)).ok).toBe(true);
  });

  it("refuses stories on a v1 bundle (a hand edit that forgot the bump would drop the lock silently)", () => {
    const res = parseBundle(JSON.stringify({ ...valid, stories: [] }));
    expect(res.ok).toBe(false);
  });

  it("reports every story problem in one pass", () => {
    const res = parseBundle(
      v2([
        { id: "op", title: "", intro: "", steps: [ids[0], ids[0], "not-in-bundle-zz99zz"] },
        { id: "op", title: "Dup id", intro: "", steps: [] },
        { id: "side", title: "Side", intro: "", steps: [ids[0]] },
      ]),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    const text = JSON.stringify(res.errors);
    expect(text).toMatch(/title/);
    expect(text).toMatch(/twice/);
    expect(text).toMatch(/not-in-bundle-zz99zz/);
    expect(text).toMatch(/unique/);
    expect(text).toMatch(/two stories|one story/);
  });
});
