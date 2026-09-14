import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as classicStore from "@/lib/classic-store";
import * as quizStore from "@/lib/quiz-store";
import * as aiStore from "@/lib/ai-store";
import * as adminStore from "@/lib/admin-store";
import * as enabledModules from "@/lib/enabled-modules";
import { DEFAULT_SECURE_DEV_TARGETS } from "@/lib/secure-dev-targets";

const m = vi.hoisted(() => ({
  exportClassic: vi.fn(), exportQuiz: vi.fn(), exportAi: vi.fn(), exportSponsors: vi.fn(), importSponsors: vi.fn(),
  getAdminSettings: vi.fn(), effectivePaused: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/classic-store", () => ({ exportBundle: m.exportClassic, clearChallenges: vi.fn(), importBundle: vi.fn() }));
vi.mock("@/lib/quiz-store", () => ({ exportBundle: m.exportQuiz, clearQuestions: vi.fn(), importBundle: vi.fn() }));
vi.mock("@/lib/ai-store", () => ({ exportBundle: m.exportAi, clearAiChallenges: vi.fn(), importBundle: vi.fn() }));
// Sponsors is a PLATFORM feature, not a content module — it has no
// clear*() here because admin-store's resetEvent (mocked below) already
// covers wiping ctf:sponsors* before an import (see event-store.ts's own
// comment on the sponsors import branch).
vi.mock("@/lib/sponsors-store", () => ({ exportBundle: m.exportSponsors, importBundle: m.importSponsors }));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings: m.getAdminSettings, effectivePaused: m.effectivePaused, updateAdminSettings: vi.fn(), resetEvent: vi.fn() }));
// event-store.ts's reconciliation (`reconcileEnabledModuleIds`) only needs
// `isModuleId` from `@/lib/modules` now — module availability is decided by
// `secureDevAvailable`/`defaultEnabledModules` (from the real, unmocked,
// pure `@/lib/module-defaults`, driven by `process.env.SCORE_IMAGE`), not by
// any baked/build-time set.
vi.mock("@/lib/modules", () => ({
  isModuleId: (v: unknown) => typeof v === "string" && ["classic", "quiz", "ai", "secure-development"].includes(v),
  // resolveSite() (real now — see the `@/lib/site` mock below) re-exports this
  // verbatim onto `Site`; the mock needs to supply it or resolveSite throws.
  SECURE_AGENT_PLAYBOOK_URL: "https://github.com/OWASP/secure-agent-playbook",
}));
// event-store.ts now builds the exported identity via `resolveSite(settings
// .eventIdentity)` — the SAME settings read `getAdminSettings()` already did
// — rather than a second `getSite()` HGETALL (finding I4: a Redis blip
// between two independent reads could otherwise write an archive whose
// event.name is the fail-open default while `bundle.settings` came from the
// good read). Keep `resolveSite` REAL (pure — no I/O) via `importActual`, and
// make `getSite` a mock that throws if event-store ever calls it again, so a
// regression back to the two-read shape fails this suite immediately instead
// of silently reintroducing the race.
vi.mock("@/lib/site", async () => {
  const actual = await vi.importActual<typeof import("@/lib/site")>("@/lib/site");
  return {
    ...actual,
    getSite: vi.fn(async () => {
      throw new Error("event-store must not call getSite() — build identity via resolveSite(settings.eventIdentity) instead");
    }),
  };
});
// `resolveSite`'s real implementation imports `@/lib/enabled-modules` only
// transitively (through `@/lib/site`'s own `getSite`, which this file never
// calls) — but `@/lib/site`'s top-level import of it still runs on
// `importActual` above, so stub it the same way site.test.ts does rather than
// letting it reach the real Redis-backed chain.
vi.mock("@/lib/enabled-modules", () => ({ getAdminSettingsSnapshot: vi.fn(async () => null) }));

import { exportEventBundle, importEventBundle, EventLiveError } from "@/lib/event-store";
import { EVENT_BUNDLE_VERSION } from "@/lib/event-io";
import { getSite } from "@/lib/site";

beforeEach(() => {
  vi.clearAllMocks();
  m.exportClassic.mockResolvedValue({ version: 1, categories: ["Web"], challenges: [{ id: "web-one-ab12cd", title: "One", category: "Web", description: "hi", points: 50, order: 0, flag: "ctfbox{One}" }] });
  m.exportQuiz.mockResolvedValue({ version: 1, questions: [] });
  m.exportAi.mockResolvedValue({ version: 1, categories: ["Prompt Injection"], challenges: [] });
  m.exportSponsors.mockResolvedValue(null);
  m.getAdminSettings.mockResolvedValue({
    hintCost: 50, teamMaxMembers: 4, enabledModuleIds: ["classic", "quiz"],
    scoringStartsAt: "2026-01-01T00:00:00Z", paused: true, updatedBy: "alice", updatedAt: "x",
    eventIdentity: {
      eventName: "Runtime CTF",
      eventTheme: "Ship",
      eventLocation: "Online",
      eventContact: "org@example.org",
      eventDiscord: "https://discord.gg/x",
    },
  });
  m.effectivePaused.mockReturnValue(true);
});

afterEach(() => {
  delete process.env.SCORE_IMAGE;
});

describe("exportEventBundle", () => {
  it("carries content but drops schedule/run settings and org PII", async () => {
    const { bundle } = await exportEventBundle(new Date("2026-06-01T00:00:00Z"));
    expect(bundle.version).toBe(EVENT_BUNDLE_VERSION);
    expect(bundle.kind).toBe("archive");
    expect(bundle.settings.hintCost).toBe(50);
    expect("scoringStartsAt" in bundle.settings).toBe(false);
    expect("paused" in bundle.settings).toBe(false);
    expect("updatedBy" in bundle.settings).toBe(false);
    expect(bundle.event.name).toBe("Runtime CTF");
    // Finding I4: one settings read, not two — resolveSite over the settings
    // already in hand, never a second getSite() HGETALL.
    expect(getSite).not.toHaveBeenCalled();
    const s = JSON.stringify(bundle);
    expect(s).not.toContain("org@example.com");
    expect(s).not.toContain('"admins"');
  });

  // #250: the ai catalogue is the third archivable content module. Included
  // exactly when `ai` is in the resolved enabled set, like classic and quiz.
  it("carries the ai catalogue when the ai module is enabled, and omits the section when it is not", async () => {
    m.getAdminSettings.mockResolvedValue({ enabledModuleIds: ["classic", "quiz", "ai"], paused: true });
    const withAi = await exportEventBundle(new Date());
    expect(withAi.bundle.ai).toEqual({ version: 1, categories: ["Prompt Injection"], challenges: [] });
    expect(m.exportAi).toHaveBeenCalledTimes(1);

    m.exportAi.mockClear();
    m.getAdminSettings.mockResolvedValue({ enabledModuleIds: ["classic", "quiz"], paused: true });
    const withoutAi = await exportEventBundle(new Date());
    expect("ai" in withoutAi.bundle).toBe(false);
    expect(m.exportAi).not.toHaveBeenCalled();
  });

  // #405: sponsors are a PLATFORM feature, not gated on enabledModuleIds —
  // whether the section appears is decided entirely by whether the store's
  // own exportBundle() found any sponsors, mirroring the "render iff
  // non-empty" rule the public surfaces follow.
  it("carries a sponsors section iff the store has at least one sponsor, regardless of enabledModuleIds", async () => {
    m.exportSponsors.mockResolvedValue({
      version: 1,
      sponsors: [{ id: "acme", name: "Acme", url: "https://acme.example", blurb: "", tier: "gold", order: 0, logo: null }],
    });
    const withSponsors = await exportEventBundle(new Date());
    expect(withSponsors.bundle.sponsors?.sponsors).toHaveLength(1);

    m.exportSponsors.mockResolvedValue(null);
    const withoutSponsors = await exportEventBundle(new Date());
    expect("sponsors" in withoutSponsors.bundle).toBe(false);
  });

  it("warns when the event is live", async () => {
    m.effectivePaused.mockReturnValue(false);
    const { warnings } = await exportEventBundle(new Date());
    expect(warnings.some((w) => /live/i.test(w))).toBe(true);
  });

  it("names Secure Development as not archivable when enabled", async () => {
    process.env.SCORE_IMAGE = "ghcr.io/x/score:latest";
    m.getAdminSettings.mockResolvedValue({ enabledModuleIds: ["secure-development", "classic"], paused: true });
    const { warnings } = await exportEventBundle(new Date());
    expect(warnings.some((w) => /secure development/i.test(w))).toBe(true);
  });

  // CodeRabbit round 1, finding F: a stored secure-development can outlive
  // its scorer image (admin-store's carry-forward rule) — the export must
  // not report it as live: no "not archivable" warning, and it must not ride
  // along in bundle.settings.enabledModuleIds for a later re-import to
  // reconcile away.
  it("narrows secure-development out of the export when there is no scorer image, even if stored", async () => {
    delete process.env.SCORE_IMAGE;
    m.getAdminSettings.mockResolvedValue({ enabledModuleIds: ["secure-development", "classic"], paused: true });
    const { bundle, warnings } = await exportEventBundle(new Date());
    expect(bundle.settings.enabledModuleIds).toEqual(["classic"]);
    expect(warnings.some((w) => /secure development/i.test(w))).toBe(false);
  });

  it("exports the RESOLVED enabledModuleIds, not the raw possibly-undefined settings field (falls back to this deployment's default modules)", async () => {
    process.env.SCORE_IMAGE = "ghcr.io/x/score:latest";
    m.getAdminSettings.mockResolvedValue({ hintCost: 50, paused: true, enabledModuleIds: undefined });
    const { bundle } = await exportEventBundle(new Date());
    // With no runtime override, exportEventBundle falls back to
    // `defaultEnabledModules(process.env)` — secure-development alone when
    // this deployment has a scorer image, empty otherwise — and
    // bundle.settings.enabledModuleIds must carry that SAME resolved array
    // rather than dropping the key.
    expect(bundle.settings.enabledModuleIds).toEqual(["secure-development"]);
  });

  // aiCooldownSec rides EVENT_POLICY_FIELDS beside classicCooldownSec (see
  // event-io.ts) — pinned by name here since neither cooldown field was
  // previously asserted anywhere in this suite.
  it("carries both modules' cooldown overrides — classicCooldownSec and aiCooldownSec — through export", async () => {
    m.getAdminSettings.mockResolvedValue({
      hintCost: 50, teamMaxMembers: 4, enabledModuleIds: ["classic", "quiz"],
      classicCooldownSec: 45, aiCooldownSec: 12,
      scoringStartsAt: "2026-01-01T00:00:00Z", paused: true, updatedBy: "alice", updatedAt: "x",
    });
    const { bundle } = await exportEventBundle(new Date("2026-06-01T00:00:00Z"));
    expect(bundle.settings.classicCooldownSec).toBe(45);
    expect(bundle.settings.aiCooldownSec).toBe(12);
  });

  // Finding C: a field ResolvedAdminSettings reports as unset — `null`, its
  // real "no override" value (see admin-store.ts), never `undefined` — must
  // be OMITTED from the exported bundle rather than written out as
  // `null`. Otherwise a fresh export of a box that never touched a newer
  // policy field (aiCooldownSec, added after v1 shipped) carries that key
  // anyway, and event-io.ts's parser rejects any settings key outside an
  // older box's own EVENT_POLICY_FIELDS allowlist — so every export from
  // this build would fail to import into a pre-this-build box even when
  // nothing the organizer actually set changed. Semantically identical on
  // import: buildPolicyPatch (below) already skips a null/absent field
  // rather than forwarding it to updateAdminSettings.
  it("omits a policy field the export loop reports as unset (null), rather than writing it out as null", async () => {
    m.getAdminSettings.mockResolvedValue({
      hintCost: 50,
      teamMaxMembers: 4,
      enabledModuleIds: ["classic", "quiz"],
      // Both null, mirroring ResolvedAdminSettings' real shape for a field
      // the organizer never overrode (see admin-store.ts ~line 296-302) —
      // not simply absent from the mock, which would already pass thanks to
      // JSON.stringify dropping `undefined` and prove nothing about the
      // actual (real-world) null case.
      classicCooldownSec: null,
      aiCooldownSec: null,
      paused: true,
    });
    const { bundle } = await exportEventBundle(new Date());
    expect("aiCooldownSec" in bundle.settings).toBe(false);
    // General rule, not an aiCooldownSec special case: any null scalar
    // policy field is dropped the same way.
    expect("classicCooldownSec" in bundle.settings).toBe(false);
    // A field that IS set still carries through — this isn't "always omit".
    expect(bundle.settings.hintCost).toBe(50);
    const s = JSON.stringify(bundle);
    expect(s).not.toContain("aiCooldownSec");
    expect(s).not.toContain("classicCooldownSec");
  });

  // Issue #386, PR 2: secureDevTargets rides EVENT_POLICY_FIELDS beside
  // enabledModuleIds, resolved the SAME way (default all six when nothing
  // stored) rather than a raw possibly-null field, and off the ONE
  // getAdminSettings() read this function already made — never a second,
  // independent read through lib/enabled-apps.ts's getSecureDevTargets
  // (which itself goes through getAdminSettingsSnapshot).
  it("carries the resolved secureDevTargets — all six when nothing is stored — off the one settings read already in hand", async () => {
    m.getAdminSettings.mockResolvedValue({ hintCost: 50, paused: true, enabledModuleIds: ["classic"] });
    const { bundle } = await exportEventBundle(new Date());
    expect(bundle.settings.secureDevTargets).toEqual(DEFAULT_SECURE_DEV_TARGETS);
    expect(m.getAdminSettings).toHaveBeenCalledTimes(1);
    expect(enabledModules.getAdminSettingsSnapshot).not.toHaveBeenCalled();
  });

  it("carries a stored, narrower secureDevTargets set through export unchanged", async () => {
    m.getAdminSettings.mockResolvedValue({
      hintCost: 50, paused: true, enabledModuleIds: ["classic"], secureDevTargets: ["dvwa", "vampi"],
    });
    const { bundle } = await exportEventBundle(new Date());
    expect(bundle.settings.secureDevTargets).toEqual(["dvwa", "vampi"]);
  });

  it("THE LEAK TEST: run-state tokens seeded into excluded settings fields never survive the allowlist", async () => {
    // exportEventBundle's ONLY allowlist decision for `settings` is the fixed
    // loop over EVENT_POLICY_FIELDS in the function body — it never reads any
    // other AdminSettings field, and never spreads the settings object
    // wholesale. The previous version of this test scanned the serialized
    // bundle for tokens that were never present anywhere in the mocked
    // return values in the first place, so it passed just as well with the
    // allowlist deleted (a naive `{...settings}` spread would have passed
    // too, trivially — nothing in the fixture ever held those strings).
    //
    // Fix: seed canary tokens into AdminSettings fields that are real
    // (readable off the mocked getAdminSettings() return value) but EXCLUDED
    // from EVENT_POLICY_FIELDS — schedule/actor bookkeeping fields
    // (`updatedBy`, `updatedAt`, `scoringStartsAt`, `scoringEndsAt`) that
    // event-io.ts's header says must never round-trip through an archive. A
    // naive `{...settings}` spread WOULD surface these; assert they still
    // don't appear, which now genuinely exercises the field-by-field
    // allowlist instead of an absence of test data.
    //
    // "ctf:admin:audit" and "solvedAt" are dropped from the original token
    // list: neither is introducible through anything exportEventBundle
    // actually reads (getAdminSettings(), getSite(), or the content
    // modules' own exportBundle()). The audit log lives under a wholly
    // separate Redis key (`ctf:admin:audit`) this function's call graph never
    // touches, and solve timestamps are guarded by classic-store's/
    // quiz-store's own exportBundle() never reading solves/attempts
    // (asserted in classic-store.test.ts/quiz-store.test.ts) rather than by
    // anything in this function. Keeping them here would be an assertion
    // that can never fail no matter what this file's allowlist logic does.
    //
    // `scoringStartsAt`/`scoringEndsAt` themselves are no longer canary
    // material for the WHOLE bundle (config v2, PR 3A): `resolveSite` now
    // legitimately derives `bundle.event.ctfStartsAt`/`dates` from them (see
    // the "derives dates/ctfStartsAt" tests above), so a token seeded there
    // is EXPECTED to surface in `bundle.event`. What must still never happen
    // is either field appearing under its OWN name in `bundle.settings` —
    // the actual excluded-field invariant this test exists to catch — so
    // that check narrows to `bundle.settings` alone below.
    m.getAdminSettings.mockResolvedValue({
      hintCost: 50,
      teamMaxMembers: 4,
      enabledModuleIds: ["classic", "quiz"],
      paused: true,
      updatedBy: "contestant-login",
      updatedAt: "team-slug-owner",
      scoringStartsAt: "2026-01-01T00:00:00Z",
      scoringEndsAt: "2026-01-03T00:00:00Z",
    });
    const { bundle } = await exportEventBundle(new Date());
    const s = JSON.stringify(bundle);
    for (const token of ["contestant-login", "team-slug"]) {
      expect(s).not.toContain(token);
    }
    const settingsJson = JSON.stringify(bundle.settings);
    expect(settingsJson).not.toContain("scoringStartsAt");
    expect(settingsJson).not.toContain("scoringEndsAt");
  });
});

const bundleFixture = () => ({
  version: 1, kind: "archive" as const,
  event: { name: "Demo CTF" },
  settings: { hintCost: 25, moduleOverrides: { classic: { title: "T" } }, enabledModuleIds: ["classic", "quiz"] },
  classic: { version: 1 as const, categories: ["Web"], challenges: [] },
  quiz: { version: 1 as const, questions: [] },
});

describe("importEventBundle", () => {
  beforeEach(() => {
    m.getAdminSettings.mockResolvedValue({ paused: true });
    m.effectivePaused.mockReturnValue(true);
    vi.mocked(classicStore.importBundle).mockResolvedValue({ created: 0, updated: 0, categories: 1 });
    vi.mocked(quizStore.importBundle).mockResolvedValue({ created: 0, updated: 0 });
    vi.mocked(adminStore.resetEvent).mockResolvedValue({ cleared: {}, resetAt: "x" });
    vi.mocked(adminStore.updateAdminSettings).mockResolvedValue({} as Awaited<ReturnType<typeof adminStore.updateAdminSettings>>);
  });

  it("refuses to import into a live event", async () => {
    m.effectivePaused.mockReturnValue(false);
    await expect(importEventBundle(bundleFixture(), "alice")).rejects.toBeInstanceOf(EventLiveError);
    expect(adminStore.resetEvent).not.toHaveBeenCalled();
    expect(classicStore.clearChallenges).not.toHaveBeenCalled();
  });

  it("clears content before importing (true replace), then sweeps run state", async () => {
    await importEventBundle(bundleFixture(), "alice");
    expect(adminStore.resetEvent).toHaveBeenCalledWith("alice");
    expect(classicStore.clearChallenges).toHaveBeenCalled();
    expect(classicStore.importBundle).toHaveBeenCalled();
    // clear must precede import
    const clearOrder = vi.mocked(classicStore.clearChallenges).mock.invocationCallOrder[0];
    const importOrder = vi.mocked(classicStore.importBundle).mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(importOrder);
  });

  it("clears ALL THREE content stores on replace, even when the bundle carries only one module (a quiz-only archive must still wipe stale classic and ai content already on the target)", async () => {
    const quizOnly = bundleFixture();
    delete (quizOnly as { classic?: unknown }).classic;
    await importEventBundle(quizOnly, "alice");
    expect(classicStore.clearChallenges).toHaveBeenCalled();
    expect(classicStore.importBundle).not.toHaveBeenCalled();
    expect(quizStore.clearQuestions).toHaveBeenCalled();
    expect(quizStore.importBundle).toHaveBeenCalled();
    expect(aiStore.clearAiChallenges).toHaveBeenCalled();
    expect(aiStore.importBundle).not.toHaveBeenCalled();
  });

  // #250: the ai section, when present, is cleared-then-imported like the
  // other two and reported in the summary under its own key.
  it("imports the ai section after clearing it, and reports it in the summary", async () => {
    vi.mocked(aiStore.importBundle).mockResolvedValue({ created: 2, updated: 0, categories: 1 });
    const withAi = {
      ...bundleFixture(),
      ai: {
        version: 1 as const,
        categories: ["Prompt Injection"],
        challenges: [
          {
            id: "pi-one-ab12cd",
            title: "One",
            category: "Prompt Injection",
            description: "hi",
            points: 50,
            order: 0,
            mode: "both" as const,
            urlTemplate: "https://ai.example/one?t={token}",
            flag: "ctfbox{One}",
          },
        ],
      },
    };
    const { summary } = await importEventBundle(withAi, "alice");
    expect(aiStore.importBundle).toHaveBeenCalledWith(withAi.ai);
    const clearOrder = vi.mocked(aiStore.clearAiChallenges).mock.invocationCallOrder[0];
    const importOrder = vi.mocked(aiStore.importBundle).mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(importOrder);
    expect(summary.ai).toEqual({ created: 2, updated: 0 });
  });

  // #405: sponsors ride the bundle like classic/quiz/ai, but with no
  // clear*() call of their own — `resetEvent` (already asserted above to run
  // before any import) covers wiping ctf:sponsors* for every import, not
  // only a sponsor-carrying one.
  it("imports the sponsors section and reports it in the summary, with no separate clear call", async () => {
    m.importSponsors.mockResolvedValue({ created: 1 });
    const withSponsors = {
      ...bundleFixture(),
      sponsors: {
        version: 1 as const,
        sponsors: [
          { id: "acme", name: "Acme", url: "https://acme.example", blurb: "", tier: "gold" as const, order: 0, logo: null },
        ],
      },
    };
    const { summary } = await importEventBundle(withSponsors, "alice");
    expect(m.importSponsors).toHaveBeenCalledWith(withSponsors.sponsors);
    expect(summary.sponsors).toEqual({ created: 1 });
  });

  it("does not call importSponsors when the bundle carries no sponsors section", async () => {
    await importEventBundle(bundleFixture(), "alice");
    expect(m.importSponsors).not.toHaveBeenCalled();
  });

  it("applies only policy settings, never schedule fields", async () => {
    await importEventBundle(bundleFixture(), "alice");
    const patch = vi.mocked(adminStore.updateAdminSettings).mock.calls[0][0];
    expect(patch.hintCost).toBe(25);
    expect("scoringStartsAt" in patch).toBe(false);
    expect("paused" in patch).toBe(false);
  });

  // Mirrors the export-side coverage above, for the same reason: neither
  // cooldown field was previously pinned by name on the import path either.
  it("applies both cooldown overrides — classicCooldownSec and aiCooldownSec — to the settings patch", async () => {
    await importEventBundle(
      { ...bundleFixture(), settings: { ...bundleFixture().settings, classicCooldownSec: 45, aiCooldownSec: 12 } },
      "alice",
    );
    const patch = vi.mocked(adminStore.updateAdminSettings).mock.calls[0][0];
    expect(patch.classicCooldownSec).toBe(45);
    expect(patch.aiCooldownSec).toBe(12);
  });

  // Fail-fast ordering, the point of Finding 1: the settings patch is
  // validated and applied BEFORE anything destructive runs, so a bad bundle
  // (updateAdminSettings throwing AdminValidationError) is rejected with
  // nothing wiped or half-replaced yet.
  it("applies the settings patch before resetEvent/clear (fail-fast order)", async () => {
    await importEventBundle(bundleFixture(), "alice");
    const settingsOrder = vi.mocked(adminStore.updateAdminSettings).mock.invocationCallOrder[0];
    const resetOrder = vi.mocked(adminStore.resetEvent).mock.invocationCallOrder[0];
    const clearOrder = vi.mocked(classicStore.clearChallenges).mock.invocationCallOrder[0];
    expect(settingsOrder).toBeLessThan(resetOrder);
    expect(settingsOrder).toBeLessThan(clearOrder);
  });

  it("rejects a bad bundle before anything destructive runs, when updateAdminSettings throws", async () => {
    vi.mocked(adminStore.updateAdminSettings).mockRejectedValueOnce(new Error("AdminValidationError: bad module id"));
    await expect(importEventBundle(bundleFixture(), "alice")).rejects.toThrow(/bad module id/);
    expect(adminStore.resetEvent).not.toHaveBeenCalled();
    expect(classicStore.clearChallenges).not.toHaveBeenCalled();
    expect(classicStore.importBundle).not.toHaveBeenCalled();
    expect(quizStore.clearQuestions).not.toHaveBeenCalled();
    expect(quizStore.importBundle).not.toHaveBeenCalled();
  });

  it("drops a null scalar policy field instead of forwarding it (a fresh export round-trip carries these)", async () => {
    await importEventBundle(
      { ...bundleFixture(), settings: { ...bundleFixture().settings, hintCost: null, teamMaxMembers: 6 } },
      "alice",
    );
    const patch = vi.mocked(adminStore.updateAdminSettings).mock.calls[0][0];
    expect("hintCost" in patch).toBe(false);
    expect(patch.teamMaxMembers).toBe(6);
  });

  // Finding A: reconcile enabledModuleIds against this deployment's actual
  // availability before it ever reaches updateAdminSettings, instead of
  // letting a cross-SD import throw AdminValidationError (a 500 at the
  // route). Availability is `secureDevAvailable(process.env)` — driven by
  // SCORE_IMAGE — not any baked/build-time set.
  it("applies a bundle that enables secure-development when this deployment has a scorer image", async () => {
    process.env.SCORE_IMAGE = "ghcr.io/x/score:latest";
    const { skipped } = await importEventBundle(
      {
        ...bundleFixture(),
        settings: { ...bundleFixture().settings, enabledModuleIds: ["secure-development", "quiz"] },
      },
      "alice",
    );
    const patch = vi.mocked(adminStore.updateAdminSettings).mock.calls[0][0];
    expect(patch.enabledModules).toEqual(["secure-development", "quiz"]);
    // Only the always-present branding notice — nothing secure-development
    // related, since this deployment can actually run it.
    expect(skipped.some((s) => /secure.development/i.test(s))).toBe(false);
  });

  it("drops secure-development with a skipped entry when there is no scorer image", async () => {
    delete process.env.SCORE_IMAGE;
    const { skipped } = await importEventBundle(
      {
        ...bundleFixture(),
        settings: { ...bundleFixture().settings, enabledModuleIds: ["secure-development", "quiz"] },
      },
      "alice",
    );
    const patch = vi.mocked(adminStore.updateAdminSettings).mock.calls[0][0];
    expect(patch.enabledModules).toEqual(["quiz"]);
    expect(skipped.some((s) => /no scorer image/.test(s))).toBe(true);
  });

  it("applies an explicitly empty enabledModuleIds set", async () => {
    const { skipped } = await importEventBundle(
      { ...bundleFixture(), settings: { ...bundleFixture().settings, enabledModuleIds: [] } },
      "alice",
    );
    const patch = vi.mocked(adminStore.updateAdminSettings).mock.calls[0][0];
    expect(patch.enabledModules).toEqual([]);
    expect(skipped.some((s) => /secure.development/i.test(s))).toBe(false);
  });

  // Issue #386, PR 2: buildPolicyPatch's secureDevTargets arm.
  it("applies a bundle's secureDevTargets to the settings patch, before resetEvent", async () => {
    await importEventBundle(
      { ...bundleFixture(), settings: { ...bundleFixture().settings, secureDevTargets: ["dvwa"] } },
      "alice",
    );
    const patch = vi.mocked(adminStore.updateAdminSettings).mock.calls[0][0];
    expect(patch.secureDevTargets).toEqual(["dvwa"]);
    const settingsOrder = vi.mocked(adminStore.updateAdminSettings).mock.invocationCallOrder[0];
    const resetOrder = vi.mocked(adminStore.resetEvent).mock.invocationCallOrder[0];
    expect(settingsOrder).toBeLessThan(resetOrder);
  });

  // Never a throw: an unrecognized target in an otherwise-good archive is
  // reported in `skipped` and dropped from the patch so the rest of the
  // import still applies — the same contract reconcileEnabledModuleIds
  // follows for enabledModuleIds.
  it("skips an invalid secureDevTargets set with a named message, and leaves the patch without the field", async () => {
    const { skipped } = await importEventBundle(
      { ...bundleFixture(), settings: { ...bundleFixture().settings, secureDevTargets: ["nope"] } },
      "alice",
    );
    const patch = vi.mocked(adminStore.updateAdminSettings).mock.calls[0][0];
    expect("secureDevTargets" in patch).toBe(false);
    expect(skipped.some((s) => s.startsWith("Skipped secureDevTargets:"))).toBe(true);
  });

  it("leaves secureDevTargets out of the patch when the bundle carries no such field", async () => {
    await importEventBundle(bundleFixture(), "alice");
    const patch = vi.mocked(adminStore.updateAdminSettings).mock.calls[0][0];
    expect("secureDevTargets" in patch).toBe(false);
  });
});

// `bundleFixture()` above is the "paused event" fixture the rest of this
// suite already uses for importEventBundle — reused here rather than a new
// one, per the same pattern.
describe("event identity in the archive (issue #386)", () => {
  it("exports name/theme/location from the runtime identity, never contact or Discord", async () => {
    const { bundle } = await exportEventBundle();
    // dates/ctfStartsAt come off the default fixture's scoringStartsAt
    // ("2026-01-01T00:00:00Z", no scoringEndsAt) via resolveSite/
    // formatDateRange — config v2, PR 3A, not event.yaml.
    expect(bundle.event).toEqual({
      name: "Runtime CTF",
      theme: "Ship",
      dates: "From Jan 1, 2026",
      location: "Online",
      ctfStartsAt: "2026-01-01T00:00:00Z",
    });
    expect(JSON.stringify(bundle)).not.toContain("discord.gg");
    expect(JSON.stringify(bundle)).not.toContain("org@example.org");
  });

  // The schedule fields come off the SAME `getAdminSettings()` read as
  // everything else in the bundle (no second Redis read) — pinned with a
  // full start/end pair so the assertion exercises formatDateRange's
  // same-year range branch too, not just the open-ended default fixture.
  it("derives dates/ctfStartsAt from a full scoring window on the same settings read", async () => {
    m.getAdminSettings.mockResolvedValue({
      eventIdentity: { eventName: "Runtime CTF" },
      scoringStartsAt: "2026-10-01T09:00:00Z",
      scoringEndsAt: "2026-10-03T18:00:00Z",
      paused: true,
    });
    const { bundle } = await exportEventBundle();
    expect(bundle.event.dates).toBe("Oct 1 – Oct 3, 2026");
    expect(bundle.event.ctfStartsAt).toBe("2026-10-01T09:00:00Z");
  });

  describe("import", () => {
    beforeEach(() => {
      m.getAdminSettings.mockResolvedValue({ paused: true });
      m.effectivePaused.mockReturnValue(true);
      vi.mocked(classicStore.importBundle).mockResolvedValue({ created: 0, updated: 0, categories: 1 });
      vi.mocked(quizStore.importBundle).mockResolvedValue({ created: 0, updated: 0 });
      vi.mocked(adminStore.resetEvent).mockResolvedValue({ cleared: {}, resetAt: "x" });
      vi.mocked(adminStore.updateAdminSettings).mockResolvedValue({} as Awaited<ReturnType<typeof adminStore.updateAdminSettings>>);
    });

    it("applies the bundle's name/theme/location through the settings patch, before anything destructive", async () => {
      await importEventBundle({ ...bundleFixture(), event: { name: "Imported CTF", theme: "Again", location: "Montevideo" } }, "alice");
      const patch = vi.mocked(adminStore.updateAdminSettings).mock.calls[0][0];
      expect(patch).toMatchObject({ eventName: "Imported CTF", eventTheme: "Again", eventLocation: "Montevideo" });
      expect(vi.mocked(adminStore.updateAdminSettings).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(adminStore.resetEvent).mock.invocationCallOrder[0],
      );
    });

    it("leaves theme/location untouched when the bundle omits them", async () => {
      await importEventBundle({ ...bundleFixture(), event: { name: "Only Name" } }, "alice");
      const patch = vi.mocked(adminStore.updateAdminSettings).mock.calls[0][0];
      expect(patch).toMatchObject({ eventName: "Only Name" });
      expect(patch).not.toHaveProperty("eventTheme");
      expect(patch).not.toHaveProperty("eventLocation");
    });

    it("no longer reports branding as skipped", async () => {
      const { skipped } = await importEventBundle(bundleFixture(), "alice");
      expect(skipped.join(" ")).not.toMatch(/baked at build time/);
    });
  });
});
