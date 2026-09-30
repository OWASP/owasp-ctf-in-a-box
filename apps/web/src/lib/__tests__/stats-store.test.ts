// Unit tests for the aggregate country counter. The two things that matter:
// the write touches nothing but the bare tally, and a country code that isn't
// ISO-3166 alpha-2 never reaches Redis. Upstash is mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLANTED_LOG_SECRET, decoratedError, expectLabelOnly } from "./log-redaction";

const mocks = vi.hoisted(() => ({
  upstashPipeline: vi.fn<(commands: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({
  upstashPipeline: mocks.upstashPipeline,
}));

import { normalizeCountry, recordCountryVisit } from "@/lib/stats-store";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("normalizeCountry", () => {
  it("accepts ISO-3166 alpha-2, case- and whitespace-insensitively", () => {
    expect(normalizeCountry("US")).toBe("US");
    expect(normalizeCountry("gb")).toBe("GB");
    expect(normalizeCountry("  de  ")).toBe("DE");
  });

  it("rejects everything else", () => {
    for (const bad of [null, undefined, "", "U", "USA", "12", "U$", "US;DROP", "COUNTRY#US", "*"]) {
      expect(normalizeCountry(bad)).toBeNull();
    }
  });
});

describe("recordCountryVisit", () => {
  it("increments the country tally and writes nothing else", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }]);
    await recordCountryVisit("us");

    expect(mocks.upstashPipeline).toHaveBeenCalledWith([["HINCRBY", "stats:countries", "US", 1]]);
    // The privacy page promises this holds a count and nothing else — no
    // login, IP, timestamp, or session id anywhere in the command.
    expect(JSON.stringify(mocks.upstashPipeline.mock.calls[0])).not.toMatch(/login|ip|user|session|agent|time|ttl/i);
  });

  it("writes nothing at all for an unusable country code", async () => {
    await recordCountryVisit("not-a-country");
    await recordCountryVisit("");
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("swallows transport errors — analytics must never break a request", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upstashPipeline.mockRejectedValueOnce(new Error("upstash down"));
    await expect(recordCountryVisit("FR")).resolves.toBeUndefined();
    // and the log line carries no personal data, only the aggregate code
    expect(consoleError.mock.calls[0][0]).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    consoleError.mockRestore();
  });

  // The shared label, not a bespoke `.message` read: capped, so an error
  // whose message quotes the request cannot carry it past 200 characters
  // into the log (#500 follow-up).
  it("logs the capped label, never the full message or the decoration", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.upstashPipeline.mockRejectedValueOnce(decoratedError(`upstash down ${"x".repeat(250)} ${PLANTED_LOG_SECRET}`));
      await expect(recordCountryVisit("FR")).resolves.toBeUndefined();
      expectLabelOnly(consoleError);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("swallows an in-band Upstash error the same as a transport error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "WRONGTYPE" }]);
    await expect(recordCountryVisit("FR")).resolves.toBeUndefined();
    consoleError.mockRestore();
  });
});
