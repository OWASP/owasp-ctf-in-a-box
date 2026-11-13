// The observation loop (#590): the opt-in gate first (one config read
// for an unconfigured or all-off box, which also reports the idle/backoff
// cadence), then the lifecycle CAS announcing
// exactly the edges this replica won, and the mark claims posting a single
// time check. Store and sender mocked; the schedule-window and detect logic
// they exercise is real.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAnnounceConfig: vi.fn(),
  getAdminSettings: vi.fn(),
  newOutboxId: vi.fn(),
  readStatePack: vi.fn(),
  stateCompareSet: vi.fn(),
  outboxPrune: vi.fn(),
  enqueueLedgerAnnouncement: vi.fn(),
  flushRetries: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/error-label", () => ({ errorLabel: () => "label" }));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings: mocks.getAdminSettings }));
vi.mock("@/lib/announce/store", () => ({
  getAnnounceConfig: mocks.getAnnounceConfig,
  newOutboxId: mocks.newOutboxId,
  readStatePack: mocks.readStatePack,
  stateCompareSet: mocks.stateCompareSet,
  outboxPrune: mocks.outboxPrune,
}));
vi.mock("@/lib/announce/sender", () => ({
  enqueueLedgerAnnouncement: mocks.enqueueLedgerAnnouncement,
  flushRetries: mocks.flushRetries,
}));

import { isLifecyclePassEnabled, runAnnounceTick } from "@/lib/announce/ticker";

const T0 = Date.parse("2026-10-14T12:00:00Z");

const captured = { webhookGeneration: 0, kindEpoch: 0 };

const config = (over: Record<string, unknown> = {}) => ({
  webhookConfigured: true,
  firstBlood: false,
  launch: false,
  pause: false,
  milestones: false,
  marks: "",
  webhookUrl: "https://discord.com/api/webhooks/1/aaaaaaaaaaaaaaaaaaaaaa",
  webhookGeneration: 0,
  kindEpochs: { "first-blood": 0, launch: 0, pause: 0, resume: 0, milestone: 0 },
  ...over,
});

/** The outbox entries handed to the atomic lifecycle CAS. */
const lifecycleEntries = () =>
  (mocks.stateCompareSet.mock.calls.at(-1)?.[3] ?? []) as {
    kind: string;
    payload: { embeds: { title?: string }[] };
    webhookGeneration: number;
    kindEpoch: number;
  }[];

const settings = (over: Record<string, unknown> = {}) => ({
  paused: false,
  scoringStartsAt: "2026-10-14T11:00:00Z",
  scoringEndsAt: null,
  eventIdentity: { eventName: "Test Event", eventTimeZone: "UTC" },
  ...over,
});

/** Asserts the tick did nothing past the config read — the efficiency
 *  contract for a box that never opted in. */
function expectConfigReadOnly() {
  expect(mocks.getAdminSettings).not.toHaveBeenCalled();
  expect(mocks.stateCompareSet).not.toHaveBeenCalled();
  expect(mocks.outboxPrune).not.toHaveBeenCalled();
  expect(mocks.flushRetries).not.toHaveBeenCalled();
  expect(mocks.enqueueLedgerAnnouncement).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.getAnnounceConfig.mockResolvedValue(config());
  mocks.getAdminSettings.mockResolvedValue(settings());
  mocks.newOutboxId.mockImplementation((kind: string) => `id-${kind}`);
  mocks.readStatePack.mockResolvedValue(null);
  mocks.stateCompareSet.mockResolvedValue({ code: 2, seq: 1, prev: "" });
  mocks.outboxPrune.mockResolvedValue(undefined);
  mocks.enqueueLedgerAnnouncement.mockResolvedValue(true);
  mocks.flushRetries.mockResolvedValue(undefined);
});

describe("tick gating", () => {
  it("an unconfigured box does nothing beyond the ONE config read", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ webhookConfigured: false, launch: true, firstBlood: true }));
    await runAnnounceTick(T0);
    expectConfigReadOnly();
  });

  it("a configured box with every switch off does nothing beyond the config read", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: false, pause: false, firstBlood: false, milestones: false }));
    await runAnnounceTick(T0);
    expectConfigReadOnly();
  });

  it("the config is re-read every tick, so an /admin change applies on the next pass", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: false }));
    await runAnnounceTick(T0);
    expect(mocks.stateCompareSet).not.toHaveBeenCalled();

    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true }));
    await runAnnounceTick(T0 + 30_000);
    expect(mocks.getAnnounceConfig).toHaveBeenCalledTimes(2);
    expect(mocks.stateCompareSet).toHaveBeenCalled();
  });
});

describe("lifecycle tick", () => {
  it("seeds the first observation silently (CAS code 2) and announces nothing", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true }));
    await runAnnounceTick(T0);
    expect(mocks.stateCompareSet).toHaveBeenCalledWith("ctf:announce:lifecycle", "", "v2|L1P0C0A0", expect.any(Array));
    expect(lifecycleEntries()).toEqual([]);
  });

  it("when lifecycle state was deleted on re-enable, seeds silently rather than announcing stale launch history", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true }));
    mocks.readStatePack.mockResolvedValue(null);
    mocks.stateCompareSet.mockResolvedValue({ code: 2, seq: 1, prev: "" });

    await runAnnounceTick(T0);

    expect(mocks.stateCompareSet).toHaveBeenCalledWith("ctf:announce:lifecycle", "", "v2|L1P0C0A0", expect.any(Array));
    expect(lifecycleEntries()).toEqual([]);
  });

  it("announces nothing when the lifecycle CAS is lost (code 0)", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true }));
    mocks.readStatePack.mockResolvedValue("v2|L0P0C0A0");
    mocks.stateCompareSet.mockResolvedValue({ code: 0, seq: 0, prev: "v2|L0P0C0A0" });

    await runAnnounceTick(T0);

    expect(mocks.stateCompareSet).toHaveBeenCalledWith("ctf:announce:lifecycle", "v2|L0P0C0A0", "v2|L1P0C0A0", expect.any(Array));
  });

  it("seeds silently and announces nothing when stored lifecycle state is unrecognized", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true }));
    mocks.readStatePack.mockResolvedValue("corrupted-unrecognized-state");
    mocks.stateCompareSet.mockResolvedValue({ code: 1, seq: 2, prev: "corrupted-unrecognized-state" });

    await runAnnounceTick(T0);

    expect(mocks.stateCompareSet).toHaveBeenCalled();
    expect(lifecycleEntries()).toEqual([]);
  });

  it("announces a won pause edge exactly once", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ pause: true }));
    // The observation is a LIVE event under a manual pause; the stored pack
    // is the un-paused one this replica last saw, so the CAS is ours to win.
    mocks.getAdminSettings.mockResolvedValue(settings({ paused: true }));
    mocks.readStatePack.mockResolvedValue("v2|L1P0C0A0");
    mocks.stateCompareSet.mockResolvedValue({ code: 1, seq: 2, prev: "v2|L1P0C0A0" });
    await runAnnounceTick(T0);
    expect(lifecycleEntries()).toEqual([
      expect.objectContaining({
        kind: "pause",
        payload: expect.objectContaining({ embeds: [expect.objectContaining({ title: "Scoring is paused" })] }),
        ...captured,
      }),
    ]);
  });

  it("stores the announced pause bit and announces the pause once", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ pause: true }));
    mocks.getAdminSettings.mockResolvedValue(settings({ paused: true }));
    mocks.readStatePack.mockResolvedValue("v2|L1P0C0A0");
    mocks.stateCompareSet.mockResolvedValue({ code: 1, seq: 2, prev: "v2|L1P0C0A0" });
    await runAnnounceTick(T0);
    expect(mocks.stateCompareSet).toHaveBeenCalledWith("ctf:announce:lifecycle", "v2|L1P0C0A0", "v2|L1P1C0A1", expect.any(Array));
    expect(lifecycleEntries()).toEqual([
      expect.objectContaining({
        kind: "pause",
        payload: expect.objectContaining({ embeds: [expect.objectContaining({ title: "Scoring is paused" })] }),
        ...captured,
      }),
    ]);
  });

  it("uses the stored announced bit to announce the resume", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ pause: true }));
    mocks.getAdminSettings.mockResolvedValue(settings({ paused: false }));
    mocks.readStatePack.mockResolvedValue("v2|L1P1C0A1");
    mocks.stateCompareSet.mockResolvedValue({ code: 1, seq: 2, prev: "v2|L1P1C0A1" });
    await runAnnounceTick(T0);
    expect(mocks.stateCompareSet).toHaveBeenCalledWith("ctf:announce:lifecycle", "v2|L1P1C0A1", "v2|L1P0C0A0", expect.any(Array));
    expect(lifecycleEntries()).toHaveLength(1);
    expect(lifecycleEntries()).toEqual([
      expect.objectContaining({
        kind: "resume",
        payload: expect.objectContaining({ embeds: [expect.objectContaining({ title: "Scoring resumed" })] }),
        ...captured,
      }),
    ]);
  });

  it("captures the lifecycle pack before settings so a concurrent update fails the stale CAS", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true }));
    mocks.readStatePack.mockResolvedValue("v2|L0P0C0A0");
    mocks.stateCompareSet.mockResolvedValue({ code: 0, seq: 0, prev: "v2|L1P0C0A0" });

    let releaseSettings: (() => void) | undefined;
    mocks.getAdminSettings.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSettings = () => resolve(settings({ scoringStartsAt: "2026-10-14T11:00:00Z" }));
        }),
    );

    const tick = runAnnounceTick(T0);
    // The pack is read first: a concurrent lifecycle observer can now move
    // the stored state while this tick waits on settings.
    await vi.waitFor(() => {
      expect(mocks.readStatePack).toHaveBeenCalledTimes(1);
      expect(mocks.getAdminSettings).toHaveBeenCalledTimes(1);
    });
    expect(mocks.readStatePack.mock.invocationCallOrder[0]).toBeLessThan(mocks.getAdminSettings.mock.invocationCallOrder[0]);
    releaseSettings?.();
    await tick;

    // The CAS uses the pre-settings pack, so the concurrent update makes it
    // lose instead of being overwritten by this tick's stale derivation.
    expect(mocks.stateCompareSet).toHaveBeenCalledWith("ctf:announce:lifecycle", "v2|L0P0C0A0", "v2|L1P0C0A0", expect.any(Array));
  });

  it("samples the observation time after its reads so a stalled pre-launch replica cannot overwrite a newer launch", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(T0 - 60_000));
      let releaseConfig: (() => void) | undefined;
      mocks.getAnnounceConfig.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseConfig = () => resolve(config({ launch: true }));
          }),
      );
      // Replica B already announced the launch while this tick was stalled in
      // its config read.
      mocks.readStatePack.mockResolvedValue("v2|L1P0C0A0");
      mocks.getAdminSettings.mockResolvedValue(settings());

      const tick = runAnnounceTick();
      expect(mocks.getAnnounceConfig).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date(T0 + 30_000));
      releaseConfig?.();
      await tick;

      // The default time is sampled after the reads, so the derivation matches
      // the captured L1 pack: no stale L0 write, no replayed launch.
      expect(mocks.stateCompareSet).not.toHaveBeenCalled();
      expect(lifecycleEntries()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps a lifecycle edge with the generation and epoch captured by the tick", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(
      config({ launch: true, webhookGeneration: 4, kindEpochs: { "first-blood": 0, launch: 2, pause: 0, resume: 0, milestone: 0 } }),
    );
    mocks.readStatePack.mockResolvedValue("v2|L0P0C0A0");
    mocks.stateCompareSet.mockResolvedValue({ code: 1, seq: 2, prev: "v2|L0P0C0A0" });
    await runAnnounceTick(T0);
    expect(lifecycleEntries()).toEqual([
      expect.objectContaining({ kind: "launch", webhookGeneration: 4, kindEpoch: 2 }),
    ]);
  });

  it("announces the launch edge when this replica wins it", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true }));
    mocks.readStatePack.mockResolvedValue("v2|L0P0C0A0");
    mocks.stateCompareSet.mockResolvedValue({ code: 1, seq: 2, prev: "v2|L0P0C0A0" });
    await runAnnounceTick(T0);
    expect(lifecycleEntries()).toEqual([
      expect.objectContaining({
        kind: "launch",
        payload: expect.objectContaining({ embeds: [expect.objectContaining({ title: "The event is live!" })] }),
        ...captured,
      }),
    ]);
  });

  it("an opt-in shortly before launch seeds pre-launch, so the launch edge still fires", async () => {
    // The box is idle and has never observed its lifecycle (the state key is
    // absent) while announcements are off.
    mocks.getAnnounceConfig.mockResolvedValue(config({ webhookConfigured: false, launch: true }));
    expect(await runAnnounceTick(T0 - 120_000)).toBe("idle");
    expect(mocks.stateCompareSet).not.toHaveBeenCalled();

    // Enabling the webhook/launch switch nudges an immediate pass. It runs
    // BEFORE the start, so it seeds the pre-launch baseline instead of a
    // first observation of an already-launched event (which seeds silently).
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true }));
    mocks.getAdminSettings.mockResolvedValue(settings({ scoringStartsAt: "2026-10-14T12:00:00Z" }));
    mocks.stateCompareSet.mockResolvedValue({ code: 2, seq: 1, prev: "" });
    expect(await runAnnounceTick(T0 - 60_000)).toBe("active");
    expect(mocks.stateCompareSet).toHaveBeenCalledWith("ctf:announce:lifecycle", "", "v2|L0P0C0A0", expect.any(Array));
    expect(lifecycleEntries()).toEqual([]);

    // At launch the next tick sees L0 → L1 and announces it.
    mocks.readStatePack.mockResolvedValue("v2|L0P0C0A0");
    mocks.stateCompareSet.mockResolvedValue({ code: 1, seq: 2, prev: "v2|L0P0C0A0" });
    await runAnnounceTick(T0 + 30_000);
    expect(lifecycleEntries()).toEqual([
      expect.objectContaining({
        kind: "launch",
        payload: expect.objectContaining({ embeds: [expect.objectContaining({ title: "The event is live!" })] }),
        ...captured,
      }),
    ]);
  });

  it("the window closing advances the state but announces nothing — no pause at the end", async () => {
    // The stored pack is the live, unpaused one; the window end has since
    // passed. The snapshot flips to closed — announcing "paused … until it
    // resumes" here would promise a resume that can never come.
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true, pause: true }));
    mocks.getAdminSettings.mockResolvedValue(settings({ scoringEndsAt: "2026-10-14T11:30:00Z" }));
    mocks.readStatePack.mockResolvedValue("v2|L1P0C0A0");
    mocks.stateCompareSet.mockResolvedValue({ code: 1, seq: 2, prev: "v2|L1P0C0A0" });
    await runAnnounceTick(T0);
    expect(mocks.stateCompareSet).toHaveBeenCalledWith("ctf:announce:lifecycle", "v2|L1P0C0A0", "v2|L1P0C1A0", expect.any(Array));
    expect(lifecycleEntries()).toEqual([]);
  });

  it("does not replay a launch that happened while the webhook was cleared, and keeps an owed resume", async () => {
    // The webhook was cleared before launch, so the lifecycle pass froze at
    // the pre-clear pack. Setting it again reconciles the observation to the
    // current (launched and closed) state, carrying the announced pause bit.
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true, pause: true }));
    mocks.getAdminSettings.mockResolvedValue(
      settings({ scoringStartsAt: "2026-10-14T11:00:00Z", scoringEndsAt: "2026-10-14T11:30:00Z" }),
    );
    mocks.readStatePack.mockResolvedValue("v2|L1P0C1A1");
    await runAnnounceTick(T0);
    // Already at the reconciled state: no CAS, so no stale launch post.
    expect(mocks.stateCompareSet).not.toHaveBeenCalled();
    expect(lifecycleEntries()).toEqual([]);

    // Extend the window and unfreeze: the pause announced before the clear
    // still owes its resume.
    mocks.getAdminSettings.mockResolvedValue(
      settings({ scoringStartsAt: "2026-10-14T11:00:00Z", scoringEndsAt: "2026-10-14T13:00:00Z" }),
    );
    mocks.stateCompareSet.mockResolvedValue({ code: 1, seq: 3, prev: "v2|L1P0C1A1" });
    await runAnnounceTick(T0 + 30_000);
    expect(mocks.stateCompareSet).toHaveBeenCalledWith("ctf:announce:lifecycle", "v2|L1P0C1A1", "v2|L1P0C0A0", expect.any(Array));
    expect(lifecycleEntries()).toHaveLength(1);
    expect(lifecycleEntries()).toEqual([
      expect.objectContaining({
        kind: "resume",
        payload: expect.objectContaining({ embeds: [expect.objectContaining({ title: "Scoring resumed" })] }),
        ...captured,
      }),
    ]);
  });

  it("advances the state but posts nothing when the edge's switch is off", async () => {
    // launch on (the pass runs), pause off: the observed pause edge is a
    // real transition this replica must record, but it must not post.
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true, pause: false }));
    mocks.getAdminSettings.mockResolvedValue(settings({ paused: true }));
    mocks.readStatePack.mockResolvedValue("v2|L1P0C0A0");
    mocks.stateCompareSet.mockResolvedValue({ code: 1, seq: 2, prev: "v2|L1P0C0A0" });
    await runAnnounceTick(T0);
    expect(mocks.stateCompareSet).toHaveBeenCalled();
    expect(lifecycleEntries()).toEqual([]);
  });

  it("does not store an announced pause the disabled switch never posted", async () => {
    // Launch on, pause off: the live freeze is recorded but never announced,
    // so it must not leave an `announced` bit that later owes a lone resume.
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true, pause: false }));
    mocks.getAdminSettings.mockResolvedValue(settings({ paused: true }));
    mocks.readStatePack.mockResolvedValue("v2|L1P0C0A0");
    mocks.stateCompareSet.mockResolvedValue({ code: 1, seq: 2, prev: "v2|L1P0C0A0" });
    await runAnnounceTick(T0);
    expect(mocks.stateCompareSet).toHaveBeenCalledWith("ctf:announce:lifecycle", "v2|L1P0C0A0", "v2|L1P1C0A0", expect.any(Array));
    expect(lifecycleEntries()).toEqual([]);

    // Enabling pause announcements during the same freeze does not turn the
    // old, unheard hold into an announced one.
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true, pause: true }));
    mocks.readStatePack.mockResolvedValue("v2|L1P1C0A0");
    await runAnnounceTick(T0 + 30_000);
    expect(mocks.stateCompareSet).toHaveBeenCalledTimes(1);
    expect(lifecycleEntries()).toEqual([]);

    // Unfreezing posts nothing: no pause was ever announced, so no resume is owed.
    mocks.getAdminSettings.mockResolvedValue(settings({ paused: false }));
    mocks.readStatePack.mockResolvedValue("v2|L1P1C0A0");
    mocks.stateCompareSet.mockResolvedValue({ code: 1, seq: 3, prev: "v2|L1P1C0A0" });
    await runAnnounceTick(T0 + 60_000);
    expect(mocks.stateCompareSet).toHaveBeenCalledWith("ctf:announce:lifecycle", "v2|L1P1C0A0", "v2|L1P0C0A0", expect.any(Array));
    expect(lifecycleEntries()).toEqual([]);
  });

  it("freezes the lifecycle state while launch and pause are both off", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ firstBlood: true }));
    await runAnnounceTick(T0);
    expect(mocks.stateCompareSet).not.toHaveBeenCalled();
  });
});

describe("milestones tick", () => {
  it("claims a crossed mark and posts the time check", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ milestones: true, marks: "30m" }));
    mocks.getAdminSettings.mockResolvedValue(settings({ scoringEndsAt: "2026-10-14T12:20:00Z" }));
    await runAnnounceTick(T0);
    expect(mocks.enqueueLedgerAnnouncement).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueLedgerAnnouncement).toHaveBeenCalledWith(
      "milestone",
      expect.anything(),
      "ctf:announce:milestone",
      [expect.stringContaining("1800000")],
      captured,
    );
  });

  it("stamps a milestone with the generation and epoch captured by the tick", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(
      config({
        milestones: true,
        marks: "30m",
        webhookGeneration: 5,
        kindEpochs: { "first-blood": 0, launch: 0, pause: 0, resume: 0, milestone: 3 },
      }),
    );
    mocks.getAdminSettings.mockResolvedValue(settings({ scoringEndsAt: "2026-10-14T12:20:00Z" }));
    await runAnnounceTick(T0);
    expect(mocks.enqueueLedgerAnnouncement).toHaveBeenCalledWith(
      "milestone",
      expect.anything(),
      "ctf:announce:milestone",
      [expect.any(String)],
      { webhookGeneration: 5, kindEpoch: 3 },
    );
  });

  it("posts ONE time check when several marks are crossed at once (no burst)", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ milestones: true, marks: "2h, 1h, 30m" }));
    // 20 minutes left: every one of the three marks has been crossed.
    mocks.getAdminSettings.mockResolvedValue(settings({ scoringEndsAt: "2026-10-14T12:20:00Z" }));
    await runAnnounceTick(T0);
    expect(mocks.enqueueLedgerAnnouncement).toHaveBeenCalledTimes(1);
    const claimed = mocks.enqueueLedgerAnnouncement.mock.calls[0][3] as string[];
    expect(claimed).toHaveLength(3);
  });

  it("claims nothing before launch — a close time with no start must never announce", async () => {
    // Not launched (ADR 59: no scoringStartsAt), close time set and a mark
    // already crossed. The channel must not get "Time remaining" for an
    // event that never opened.
    mocks.getAnnounceConfig.mockResolvedValue(config({ milestones: true, marks: "30m" }));
    mocks.getAdminSettings.mockResolvedValue(settings({ scoringStartsAt: null, scoringEndsAt: "2026-10-14T12:20:00Z" }));
    await runAnnounceTick(T0);
    expect(mocks.enqueueLedgerAnnouncement).not.toHaveBeenCalled();
    expect(lifecycleEntries()).toEqual([]);
  });

  it("claims nothing while scoring is manually paused", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ milestones: true, marks: "30m" }));
    mocks.getAdminSettings.mockResolvedValue(settings({ paused: true, scoringEndsAt: "2026-10-14T12:20:00Z" }));
    await runAnnounceTick(T0);
    expect(mocks.enqueueLedgerAnnouncement).not.toHaveBeenCalled();
    expect(lifecycleEntries()).toEqual([]);
  });

  it("claims nothing while the switch is off — and a first-blood-only box never even reads settings", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ firstBlood: true, milestones: false, marks: "30m" }));
    mocks.getAdminSettings.mockResolvedValue(settings({ scoringEndsAt: "2026-10-14T12:20:00Z" }));
    await runAnnounceTick(T0);
    // Settings exist only for the lifecycle/marks passes; a box running on
    // first blood alone keeps its per-tick reads to config + outbox sweeps.
    expect(mocks.getAdminSettings).not.toHaveBeenCalled();
    expect(mocks.enqueueLedgerAnnouncement).not.toHaveBeenCalled();
    expect(lifecycleEntries()).toEqual([]);
  });

  it("after a master reset (announce state wiped, webhook kept) a tick announces nothing", async () => {
    // The reset wipes ctf:announce:* (no pack, no claims) while the webhook
    // and switches survive — the fresh run must start SILENT, with no
    // challenge-shaped post of any kind replayed into the channel.
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true, firstBlood: true, pause: true, milestones: true, marks: "30m" }));
    mocks.getAdminSettings.mockResolvedValue(settings({ scoringStartsAt: null, paused: true }));
    mocks.readStatePack.mockResolvedValue(null);
    mocks.stateCompareSet.mockResolvedValue({ code: 2, seq: 1, prev: "" });
    await runAnnounceTick(T0);
    expect(mocks.stateCompareSet).toHaveBeenCalledWith("ctf:announce:lifecycle", "", "v2|L0P1C0A0", expect.any(Array));
    expect(lifecycleEntries()).toEqual([]);
    expect(mocks.enqueueLedgerAnnouncement).not.toHaveBeenCalled();
  });
});

describe("tick cadence", () => {
  it("an unconfigured or all-off box reports the idle (backoff) cadence", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ webhookConfigured: false, launch: true }));
    expect(await runAnnounceTick(T0)).toBe("idle");
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: false, pause: false, firstBlood: false, milestones: false }));
    expect(await runAnnounceTick(T0)).toBe("idle");
  });

  it("an armed box reports the active cadence", async () => {
    mocks.getAnnounceConfig.mockResolvedValue(config({ launch: true }));
    expect(await runAnnounceTick(T0)).toBe("active");
  });

  it("a FAILED config read reports 'unknown' — a blip must not back off a configured box", async () => {
    mocks.getAnnounceConfig.mockRejectedValue(new Error("redis down"));
    expect(await runAnnounceTick(T0)).toBe("unknown");
    expectConfigReadOnly();
  });
});

describe("boot cadence", () => {
  it("a failed first config read retries on the active interval, not the five-minute backoff", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
    const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    try {
      delete (globalThis as Record<string, unknown>).__ctfAnnounceTicker;
      mocks.getAnnounceConfig.mockRejectedValue(new Error("redis down"));
      const ticker = await import("@/lib/announce/ticker");
      ticker.startAnnounceTicker();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(mocks.getAnnounceConfig).toHaveBeenCalledTimes(1);
      // The failed read must not push the retry out to the idle backoff.
      await vi.advanceTimersByTimeAsync(ticker.ANNOUNCE_TICK_MS);
      expect(mocks.getAnnounceConfig).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      delete (globalThis as Record<string, unknown>).__ctfAnnounceTicker;
      vi.useRealTimers();
      if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
      if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
    }
  });
});

describe("isLifecyclePassEnabled", () => {
  it("is true if launch or pause is on, false when both are off", () => {
    expect(isLifecyclePassEnabled({ launch: true, pause: false })).toBe(true);
    expect(isLifecyclePassEnabled({ launch: false, pause: true })).toBe(true);
    expect(isLifecyclePassEnabled({ launch: true, pause: true })).toBe(true);
    expect(isLifecyclePassEnabled({ launch: false, pause: false })).toBe(false);
    expect(isLifecyclePassEnabled({})).toBe(false);
  });
});
