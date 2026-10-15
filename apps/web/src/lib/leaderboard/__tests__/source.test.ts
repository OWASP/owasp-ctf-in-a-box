// LEADERBOARD_SOURCE resolution.
//
// The failure this guards against is a typo that costs nothing at boot and
// everything at the event: an unrecognised value falls back to "mock", so the
// board serves placeholder standings to real contestants.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The source modules reach for network clients at import time; none of that
// is exercised here, only which one gets picked.
vi.mock("@/lib/leaderboard/mock", () => ({ mockSource: { id: "mock" } }));
vi.mock("@/lib/leaderboard/lambda", () => ({ lambdaSource: { id: "lambda" } }));
// This suite is about LEADERBOARD_SOURCE resolution, not module gating — the
// secure-development gate is exercised separately in source-empty.test.ts.
// Live to true so every mode below runs the branch that reads the env var.
vi.mock("@/lib/enabled-modules", () => ({ isModuleLive: async () => true }));

/** Fresh module each time, so the warn-once Set does not leak between tests. */
async function loadWith(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) delete process.env.LEADERBOARD_SOURCE;
  else process.env.LEADERBOARD_SOURCE = value;
  return import("@/lib/leaderboard/source");
}

const original = process.env.LEADERBOARD_SOURCE;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  if (original === undefined) delete process.env.LEADERBOARD_SOURCE;
  else process.env.LEADERBOARD_SOURCE = original;
});

describe("getLeaderboardSourceMode", () => {
  it.each(["mock", "lambda"])("passes %s through silently", async (value) => {
    const { getLeaderboardSourceMode } = await loadWith(value);
    expect(await getLeaderboardSourceMode()).toBe(value);
    expect(warn).not.toHaveBeenCalled();
  });

  // A direct-Upstash read is not a mode this app ships: a box whose .env
  // names it must land on the placeholder board with the warning, not on a
  // read of a schema no deployed source writes.
  it("warns and falls back to mock for upstash, which no source implements", async () => {
    const { getLeaderboardSourceMode } = await loadWith("upstash");
    expect(await getLeaderboardSourceMode()).toBe("mock");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("upstash");
  });

  it("defaults to mock when unset, without warning", async () => {
    const { getLeaderboardSourceMode } = await loadWith(undefined);
    expect(await getLeaderboardSourceMode()).toBe("mock");
    // Unset is the documented default, not a mistake — warning on it would
    // train people to ignore the message that matters.
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and falls back to mock for an unrecognised value", async () => {
    const { getLeaderboardSourceMode } = await loadWith("dynamo");
    expect(await getLeaderboardSourceMode()).toBe("mock");
    expect(warn).toHaveBeenCalledTimes(1);

    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("dynamo");
    // The message has to carry the consequence and the remedy, or it is just
    // noise in a log nobody reads during an event.
    expect(message).toContain("placeholder data");
    expect(message).toContain("mock");
  });

  it.each(["DYNAMO", " dynamo", "postgres", "true"])(
    "warns for other unrecognised value %s",
    async (value) => {
      const { getLeaderboardSourceMode } = await loadWith(value);
      expect(await getLeaderboardSourceMode()).toBe("mock");
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it("warns once, not once per request", async () => {
    const { getLeaderboardSourceMode } = await loadWith("dynamodb");
    // Called on every leaderboard render; an un-deduped warn would flood logs.
    for (let i = 0; i < 25; i++) await getLeaderboardSourceMode();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("getLeaderboardSource", () => {
  it.each([
    ["lambda", "lambda"],
    ["upstash", "mock"],
    ["mock", "mock"],
    ["dynamo", "mock"],
  ])("resolves %s to the %s source", async (value, expected) => {
    const { getLeaderboardSource } = await loadWith(value);
    expect(((await getLeaderboardSource()) as unknown as { id: string }).id).toBe(expected);
  });
});
