import { describe, expect, it } from "vitest";
import {
  EVENT_BUNDLE_MIN_VERSION,
  EVENT_BUNDLE_VERSION,
  parseEventBundle,
  serializeEventBundle,
  type EventBundle,
} from "@/lib/event-io";

const valid: EventBundle = {
  version: EVENT_BUNDLE_VERSION,
  kind: "archive",
  event: { name: "Demo CTF", theme: "web", dates: "2026", location: "online", ctfStartsAt: null },
  settings: { hintCost: 50, teamMaxMembers: 4, enabledModuleIds: ["classic", "quiz"], classicCooldownSec: 45, aiCooldownSec: 12 },
  classic: {
    version: 1,
    categories: ["Web"],
    challenges: [{ id: "web-one-ab12cd", title: "One", category: "Web", description: "hi", points: 50, order: 0, flag: "ctfbox{One}" }],
  },
  quiz: {
    version: 1,
    questions: [{ id: "q-one-ab12cd", prompt: "P?", type: "single", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], points: 10, order: 0, correct: ["a"] }],
  },
  ai: {
    version: 1,
    categories: ["Prompt Injection"],
    challenges: [
      {
        id: "pi-one-ab12cd",
        title: "One",
        category: "Prompt Injection",
        description: "hi",
        points: 50,
        order: 0,
        mode: "both",
        urlTemplate: "https://ai.example/one?t={token}",
        flag: "ctfbox{One}",
        signingKey: "aik_one",
      },
    ],
  },
};

describe("parseEventBundle", () => {
  it("accepts a well-formed bundle and round-trips its serialization", () => {
    const res = parseEventBundle(serializeEventBundle(valid));
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.bundle).toEqual(valid);
  });

  it("reports malformed JSON as one generic error with no input echoed", () => {
    const res = parseEventBundle('{not json ctfbox{secret}');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].where).toBe("(document)");
    expect(JSON.stringify(res.errors)).not.toContain("secret");
  });

  it("refuses a newer bundle version, no partial apply", () => {
    const res = parseEventBundle(JSON.stringify({ ...valid, version: EVENT_BUNDLE_VERSION + 1 }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors[0].message).toContain("newer than this box supports");
  });

  it("refuses a version older than EVENT_BUNDLE_MIN_VERSION", () => {
    const res = parseEventBundle(JSON.stringify({ ...valid, version: EVENT_BUNDLE_MIN_VERSION - 1 }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors[0].message).toContain("Unsupported bundle version");
  });

  it("refuses a fractional version — the range check must not admit an undefined schema", () => {
    const res = parseEventBundle(JSON.stringify({ ...valid, version: 1.5 }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors[0].where).toBe("version");
    expect(res.errors[0].message).toContain("Unsupported bundle version");
  });

  // CodeRabbit round 1 (issue #386 PR 3): `secureDevTargets` joined
  // EVENT_POLICY_FIELDS without a version bump, so a pre-change v1 parser
  // (whose own EVENT_POLICY_FIELDS never heard of the field) would reject a
  // bundle carrying it as "field not allowed" rather than a clean version
  // mismatch. This box's own parser must still accept a genuine legacy v1
  // bundle — one that predates the field and simply never carries it — and
  // normalize it to the current version on the way in, same as any other
  // accepted bundle.
  it("accepts a legacy v1 bundle with no secureDevTargets field, normalized to the current version", () => {
    const legacyV1: EventBundle = { ...valid, version: EVENT_BUNDLE_MIN_VERSION };
    expect("secureDevTargets" in legacyV1.settings).toBe(false);
    const res = parseEventBundle(JSON.stringify(legacyV1));
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.bundle.version).toBe(EVENT_BUNDLE_VERSION);
    expect("secureDevTargets" in res.bundle.settings).toBe(false);
  });

  it("refuses a non-archive kind", () => {
    const res = parseEventBundle(JSON.stringify({ ...valid, kind: "backup" }));
    expect(res.ok).toBe(false);
  });

  it("refuses settings carrying a schedule/run field", () => {
    const res = parseEventBundle(JSON.stringify({ ...valid, settings: { ...valid.settings, scoringStartsAt: "2026-01-01T00:00:00Z" } }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors.some((e) => e.where === "settings")).toBe(true);
  });

  it("refuses settings carrying paused", () => {
    const res = parseEventBundle(JSON.stringify({ ...valid, settings: { ...valid.settings, paused: true } }));
    expect(res.ok).toBe(false);
  });

  it("folds embedded classic errors under a classic prefix", () => {
    const bad = { ...valid, classic: { ...valid.classic, challenges: [{ ...valid.classic!.challenges[0], points: -5 }] } };
    const res = parseEventBundle(JSON.stringify(bad));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors.some((e) => e.where.startsWith("classic"))).toBe(true);
  });

  it("folds embedded ai errors under an ai prefix", () => {
    const bad = { ...valid, ai: { ...valid.ai, challenges: [{ ...valid.ai!.challenges[0], urlTemplate: "https://no-token.example/" }] } };
    const res = parseEventBundle(JSON.stringify(bad));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors.some((e) => e.where.startsWith("ai.challenges[0].urlTemplate"))).toBe(true);
  });

  // Issue #386, PR 2: secureDevTargets rides EVENT_POLICY_FIELDS alongside
  // enabledModuleIds — an archive that carries it is not "field not allowed".
  it("accepts settings carrying secureDevTargets", () => {
    const withTargets = { ...valid, settings: { ...valid.settings, secureDevTargets: ["dvwa", "vampi"] } };
    const res = parseEventBundle(JSON.stringify(withTargets));
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.bundle.settings.secureDevTargets).toEqual(["dvwa", "vampi"]);
  });

  it("requires at least one module", () => {
    const res = parseEventBundle(JSON.stringify({ version: 1, kind: "archive", event: valid.event, settings: {} }));
    expect(res.ok).toBe(false);
  });

  it("accepts an ai-only archive — ai alone satisfies the at-least-one-module rule", () => {
    const aiOnly = { version: 1, kind: "archive", event: valid.event, settings: {}, ai: valid.ai };
    const res = parseEventBundle(JSON.stringify(aiOnly));
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.bundle.ai).toEqual(valid.ai);
    expect(res.bundle.classic).toBeUndefined();
    expect(res.bundle.quiz).toBeUndefined();
  });

  // Finding M4: a non-string theme/location/dates (or non-string/non-null
  // ctfStartsAt) is REJECTED like every other malformed bundle field, not
  // silently ignored — event-store's `typeof bundle.event.theme === "string"`
  // import guard would otherwise drop a wrong-typed value with no error at
  // all.
  it.each([
    ["theme", 42, "event.theme"],
    ["location", 42, "event.location"],
    ["dates", 42, "event.dates"],
    ["ctfStartsAt", 42, "event.ctfStartsAt"],
  ])("rejects a non-string event.%s", (field, badValue, where) => {
    const bad = { ...valid, event: { ...valid.event, [field]: badValue } };
    const res = parseEventBundle(JSON.stringify(bad));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors.some((e) => e.where === where)).toBe(true);
  });

  it("accepts a null ctfStartsAt but rejects any other non-string value", () => {
    const withNull = { ...valid, event: { ...valid.event, ctfStartsAt: null } };
    expect(parseEventBundle(JSON.stringify(withNull)).ok).toBe(true);
  });

  it("accumulates all errors rather than stopping at the first", () => {
    const res = parseEventBundle(JSON.stringify({ version: 99, kind: "nope", event: {}, settings: { paused: true } }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.errors.length).toBeGreaterThan(1);
  });
});

// #186: the archive carries upload BYTES (the classic bundle carries only
// metadata). Shape is checked here — client-safe; the sha256 of the bytes is
// verified server-side before the import wipes anything.
describe("attachment files in the archive (#186)", () => {
  const bytes = Buffer.from("pcap-bytes").toString("base64");
  const sha = "ab".repeat(32);
  const withFiles = (files: unknown, sha256 = sha) =>
    JSON.stringify({
      ...valid,
      classic: {
        version: 2,
        categories: ["Web"],
        challenges: [{ ...valid.classic!.challenges[0], attachments: [{ name: "cap.pcap", size: 10, sha256 }] }],
      },
      attachmentFiles: files,
    });
  const fileErrors = (text: string) => {
    const r = parseEventBundle(text);
    return r.ok ? [] : r.errors.filter((e) => e.where.startsWith("attachmentFiles"));
  };

  it("accepts files that match a classic upload's metadata, and keeps them", () => {
    const res = parseEventBundle(withFiles([{ item: "web-one-ab12cd", sha256: sha, bytes }]));
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.bundle.attachmentFiles).toEqual([{ item: "web-one-ab12cd", sha256: sha, bytes }]);
  });

  it.each([
    ["a file no classic upload names", [{ item: "web-one-ab12cd", sha256: "cd".repeat(32), bytes }]],
    ["an unknown challenge", [{ item: "ghost-zz99zz", sha256: sha, bytes }]],
    ["bytes that are not base64", [{ item: "web-one-ab12cd", sha256: sha, bytes: "not base64!!" }]],
    ["an extra key", [{ item: "web-one-ab12cd", sha256: sha, bytes, name: "x" }]],
    ["a non-array", "cap.pcap"],
  ])("refuses %s", (_label, files) => {
    expect(fileErrors(withFiles(files)).length).toBeGreaterThan(0);
  });

  it("refuses files on an archive without a classic section", () => {
    const rest: Partial<EventBundle> = { ...valid };
    delete rest.classic;
    expect(fileErrors(JSON.stringify({ ...rest, attachmentFiles: [{ item: "web-one-ab12cd", sha256: sha, bytes }] })).length).toBeGreaterThan(0);
  });

  // #500 (S9): the validator's messages are echoed back to the admin client.
  // They must name WHERE (the indexed path) and WHAT rule, never the uploaded
  // file's own values — an arbitrary `sha256`, `item` or key name is attacker-
  // or accident-shaped text, and a pasted secret must not ride back out in it.
  describe("messages never echo the file's own values (#500)", () => {
    const PLANTED = "PLANTED-archive-value-91c2";

    it("refuses a sha256 that is not 64 lowercase hex, at the indexed path, without echoing it", () => {
      const errors = fileErrors(withFiles([{ item: "web-one-ab12cd", sha256: `${PLANTED}-not-hex`, bytes }]));
      expect(errors).toContainEqual({ where: "attachmentFiles[0].sha256", message: "sha256 must be 64 lowercase hex digits" });
      expect(JSON.stringify(errors)).not.toContain(PLANTED);
    });

    it("refuses an unmatched (item, sha256) pair without echoing either", () => {
      const other = "cd".repeat(32);
      const errors = fileErrors(withFiles([{ item: `${PLANTED}-item`, sha256: other, bytes }]));
      expect(errors.some((e) => e.where === "attachmentFiles[0]")).toBe(true);
      const text = JSON.stringify(errors);
      expect(text).not.toContain(PLANTED);
      expect(text).not.toContain(other);
    });

    it("refuses unknown keys without echoing their names", () => {
      const errors = fileErrors(withFiles([{ item: "web-one-ab12cd", sha256: sha, bytes, [PLANTED]: "x" }]));
      expect(errors.some((e) => e.where === "attachmentFiles[0]" && /unknown key/i.test(e.message))).toBe(true);
      expect(JSON.stringify(errors)).not.toContain(PLANTED);
    });
  });
});

// The archive's own top-level checks and the embedded sponsors section follow
// the same rule as the attachment files above: the indexed path and the rule,
// never the submitted value or key name (#500 follow-up).
describe("archive-level errors never echo the submitted value (#500)", () => {
  const PLANTED = "FLAG{do-not-echo}";
  const PLANTED_ID = "planted-do-not-echo";

  function errorsOf(bundle: unknown): { where: string; message: string }[] {
    const res = parseEventBundle(JSON.stringify(bundle));
    if (res.ok) throw new Error("expected the bundle to be rejected, but it parsed");
    return res.errors;
  }
  function expectNoEcho(errors: { where: string; message: string }[], where: string, secret = PLANTED): void {
    expect(errors.some((e) => e.where === where)).toBe(true);
    expect(JSON.stringify(errors)).not.toContain(secret);
  }

  it("a bad version, a bad kind and a settings key outside the allowlist never echo", () => {
    expectNoEcho(errorsOf({ ...valid, version: PLANTED }), "version");
    expectNoEcho(errorsOf({ ...valid, kind: PLANTED }), "kind");
    expectNoEcho(errorsOf({ ...valid, settings: { ...valid.settings, [PLANTED]: 1 } }), "settings");
  });

  it("the sponsors section's version and duplicate ids never echo", () => {
    const sponsor = { id: PLANTED_ID, name: "Acme", url: "https://acme.example", blurb: "", tier: "gold", order: 0, logo: null };
    expectNoEcho(errorsOf({ ...valid, sponsors: { version: PLANTED, sponsors: [] } }), "sponsors.version");
    expectNoEcho(errorsOf({ ...valid, sponsors: { version: 1, sponsors: [sponsor, sponsor] } }), "sponsors.sponsors[1].id", PLANTED_ID);
  });
});
