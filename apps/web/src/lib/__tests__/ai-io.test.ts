// The ai bundle parser mirrors classic-io.ts's contract: client-safe, every
// error in one pass, and per-challenge rules identical to `upsertAiChallenge`.
// The rules with no classic equivalent — a launch template must carry
// `{token}`, a mode must parse, a flag is required unless the challenge is
// event-only and forbidden when it is, a signing key is optional but must be
// a non-empty string when present — get their own cases.
import { describe, expect, it } from "vitest";
import { AI_BUNDLE_VERSION, parseBundle, serializeBundle, type AiBundle } from "@/lib/ai-io";

const valid: AiBundle = {
  version: AI_BUNDLE_VERSION,
  categories: ["Prompt Injection", "Guardrails"],
  challenges: [
    {
      id: "pi-one-ab12cd",
      title: "One",
      category: "Prompt Injection",
      description: "Make it say the word.",
      points: 50,
      order: 0,
      mode: "both",
      urlTemplate: "https://ai.example/one?t={token}",
      flag: "ctfbox{One}",
      hint: "Ask nicely.",
      signingKey: "aik_test-key-one",
    },
    {
      id: "gr-two-ab12cd",
      title: "Two",
      category: "Guardrails",
      description: "Event-only.",
      points: 20,
      order: 1,
      mode: "event",
      urlTemplate: "https://ai.example/two?t={token}",
    },
  ],
};

const asJson = (b: unknown) => JSON.stringify(b);

describe("parseBundle (ai)", () => {
  it("accepts a well-formed bundle", () => {
    const res = parseBundle(asJson(valid));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.bundle).toEqual(valid);
  });

  it("round-trips its own serialization", () => {
    const res = parseBundle(serializeBundle(valid));
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.bundle).toEqual(valid);
  });

  it("reports malformed JSON as one generic error with no input echoed", () => {
    const res = parseBundle('{"categories": ctfbox{Sec');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toEqual([{ where: "(document)", message: "Invalid JSON" }]);
      expect(JSON.stringify(res.errors)).not.toContain("ctfbox");
    }
  });

  it("rejects an unknown version rather than misparsing it", () => {
    const res = parseBundle(asJson({ ...valid, version: 99 }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.where === "version")).toBe(true);
  });

  it("rejects a top-level shape that is not an object with a challenges array", () => {
    expect(parseBundle("[]").ok).toBe(false);
    expect(parseBundle(asJson({ version: 1, categories: [] })).ok).toBe(false);
  });

  it("requires a flag on a graded challenge and forbids one on an event-only challenge", () => {
    const [graded, eventOnly] = valid.challenges;
    const noFlag = { ...graded };
    delete (noFlag as { flag?: string }).flag;
    const res1 = parseBundle(asJson({ ...valid, challenges: [noFlag] }));
    expect(res1.ok).toBe(false);
    if (!res1.ok) expect(res1.errors).toEqual([{ where: "challenges[0].flag", message: expect.stringMatching(/required/i) }]);

    const res2 = parseBundle(asJson({ ...valid, challenges: [{ ...eventOnly, flag: "ctfbox{stray}" }] }));
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.errors).toEqual([{ where: "challenges[0].flag", message: expect.stringMatching(/event-only/i) }]);
  });

  it("rejects an unknown mode and a launch template without the {token} placeholder", () => {
    const [graded] = valid.challenges;
    const res = parseBundle(
      asJson({ ...valid, challenges: [{ ...graded, mode: "sometimes", urlTemplate: "https://ai.example/one" }] }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.map((e) => e.where).sort()).toEqual(["challenges[0].mode", "challenges[0].urlTemplate"]);
    }
  });

  it("accepts a missing signingKey (import mints one) but refuses an empty or non-string one", () => {
    const [graded] = valid.challenges;
    const noKey = { ...graded };
    delete (noKey as { signingKey?: string }).signingKey;
    expect(parseBundle(asJson({ ...valid, challenges: [noKey] })).ok).toBe(true);

    for (const bad of ["", 42, null]) {
      const res = parseBundle(asJson({ ...valid, challenges: [{ ...graded, signingKey: bad }] }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors.map((e) => e.where)).toEqual(["challenges[0].signingKey"]);
    }
  });

  it("collects EVERY error rather than stopping at the first", () => {
    const res = parseBundle(
      asJson({
        version: AI_BUNDLE_VERSION,
        categories: ["A", "a", 7],
        challenges: [
          { id: "bad id!", title: "", category: "Nope", description: 5, points: -1, order: 1.5, mode: "both", urlTemplate: "x", flag: "" },
          { id: "dup-ab12cd", title: "T", category: "A", description: "", points: 1, order: 0, mode: "flag", urlTemplate: "https://x/{token}", flag: "f", extra: true },
          { id: "dup-ab12cd", title: "T", category: "A", description: "", points: 1, order: 0, mode: "flag", urlTemplate: "https://x/{token}", flag: "f" },
        ],
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const wheres = res.errors.map((e) => e.where);
      for (const w of [
        "categories[1]",
        "categories[2]",
        "challenges[0].id",
        "challenges[0].title",
        "challenges[0].category",
        "challenges[0].description",
        "challenges[0].points",
        "challenges[0].order",
        "challenges[0].urlTemplate",
        "challenges[0].flag",
        "challenges[1]",
        "challenges[2].id",
      ]) {
        expect(wheres).toContain(w);
      }
    }
  });

  it("refuses a non-boolean caseSensitive and an over-long or empty hint", () => {
    const [graded] = valid.challenges;
    const res = parseBundle(asJson({ ...valid, challenges: [{ ...graded, caseSensitive: "true", hint: "" }] }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.map((e) => e.where).sort()).toEqual(["challenges[0].caseSensitive", "challenges[0].hint"]);
  });
});

describe("serializeBundle (ai)", () => {
  it("emits indented JSON ending in a newline", () => {
    const text = serializeBundle(valid);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "categories": [');
  });
});

// The error list goes back to the admin client verbatim, and a bundle's
// values are arbitrary text: an id, a category, a mode or a key name can
// carry a flag or a pasted signing key. Every message names the indexed path
// and the rule, never the submitted value (#500 follow-up, the shape
// event-io.ts's `validateAttachmentFiles` set).
describe("ai import errors never echo the submitted value (#500)", () => {
  const PLANTED = "FLAG{do-not-echo}";
  const PLANTED_ID = "planted-do-not-echo";
  const c0 = valid.challenges[0];

  function errorsOf(bundle: unknown): { where: string; message: string }[] {
    const res = parseBundle(asJson(bundle));
    if (res.ok) throw new Error("expected the bundle to be rejected, but it parsed");
    return res.errors;
  }
  function expectNoEcho(errors: { where: string; message: string }[], where: string, secret = PLANTED): void {
    expect(errors.some((e) => e.where === where)).toBe(true);
    expect(JSON.stringify(errors)).not.toContain(secret);
  }
  const withChallenge = (patch: Record<string, unknown>) => ({ ...valid, challenges: [{ ...c0, ...patch }] });

  it("an invalid id, an unknown category, an unknown mode and unknown keys never echo", () => {
    expectNoEcho(errorsOf(withChallenge({ id: PLANTED })), "challenges[0].id");
    expectNoEcho(errorsOf(withChallenge({ category: PLANTED })), "challenges[0].category");
    expectNoEcho(errorsOf(withChallenge({ mode: PLANTED })), "challenges[0].mode");
    expectNoEcho(errorsOf(withChallenge({ [PLANTED]: 1 })), "challenges[0]");
  });

  it("a duplicate challenge id and a duplicate category name the position, not the value", () => {
    const dup = { ...c0, id: PLANTED_ID };
    expectNoEcho(errorsOf({ ...valid, challenges: [dup, dup] }), "challenges[1].id", PLANTED_ID);
    expectNoEcho(errorsOf({ ...valid, categories: [...valid.categories, PLANTED, PLANTED] }), "categories[3]");
  });
});
