import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apps } from "@/lib/apps";
import {
  DEFAULT_SECURE_DEV_TARGETS, SECURE_DEV_TARGETS_MESSAGE, TARGET_IDS,
  checkSecureDevTargets, isAppId, normalizeSecureDevTargets,
} from "@/lib/secure-dev-targets";

describe("secure-dev targets contract", () => {
  it("TARGET_IDS is the catalogue in order and is the default", () => {
    expect([...TARGET_IDS]).toEqual(apps.map((a) => a.id));
    expect(DEFAULT_SECURE_DEV_TARGETS).toBe(TARGET_IDS);
    expect(TARGET_IDS).toHaveLength(6);
  });
  it("isAppId knows the six and nothing else", () => {
    expect(isAppId("dvwa")).toBe(true);
    expect(isAppId("DVWA")).toBe(false);
    expect(isAppId(7)).toBe(false);
  });
});

describe("normalizeSecureDevTargets", () => {
  it("absent, empty and garbage all mean default", () => {
    expect(normalizeSecureDevTargets(undefined)).toBeNull();
    expect(normalizeSecureDevTargets("")).toBeNull();
    expect(normalizeSecureDevTargets("not json")).toBeNull();
    expect(normalizeSecureDevTargets('{"a":1}')).toBeNull();
    expect(normalizeSecureDevTargets("[]")).toBeNull();
    expect(normalizeSecureDevTargets('["nope"]')).toBeNull();
  });
  it("drops unknown ids, dedups, and returns catalogue order", () => {
    expect(normalizeSecureDevTargets('["vampi","dvwa","vampi","zzz"]')).toEqual(["dvwa", "vampi"]);
  });
});

describe("checkSecureDevTargets", () => {
  it("accepts a non-empty list of known ids, normalised", () => {
    expect(checkSecureDevTargets(["vampi", "dvwa", "dvwa"])).toEqual({ ok: true, value: ["dvwa", "vampi"] });
  });
  it.each([[[]], [["dvwa", "nope"]], ["dvwa"], [null], [[1]]])("rejects %j", (v) => {
    expect(checkSecureDevTargets(v)).toEqual({ ok: false, message: SECURE_DEV_TARGETS_MESSAGE });
  });
});

// Shared with sync/test/redis.test.js (getSecureDevTargets): the same stored
// value must decode to the same list in both readers, and where either cannot
// use it, each fails in its own documented direction — the app to the
// default, the poller to a refusal (the corpus's _comment says why).
const SDT_CORPUS_PATH = fileURLToPath(
  new URL("../../../../../test/fixtures/secure-dev-targets-corpus.json", import.meta.url),
);
const { cases: sdtCorpus } = JSON.parse(readFileSync(SDT_CORPUS_PATH, "utf8")) as {
  cases: { description: string; raw: string | null; app: string[] | "default" }[];
};

describe("normalizeSecureDevTargets: shared secure-dev-targets corpus", () => {
  it("has at least its committed 15 rows", () => {
    expect(sdtCorpus.length).toBeGreaterThanOrEqual(15);
  });
  for (const { description, raw, app } of sdtCorpus) {
    it(description, () => {
      expect(normalizeSecureDevTargets(raw ?? undefined)).toEqual(app === "default" ? null : app);
    });
  }
});
