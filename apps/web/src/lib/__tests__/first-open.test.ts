// The first-open record behind Insights' open-to-solve time (#616): one
// HSETNX per login per challenge, so a later visit never moves it. It is a
// metric, not a gate, so a failed write never fails the page.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ upstashPipeline: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: m.upstashPipeline }));

import { recordFirstOpen } from "@/lib/first-open";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recordFirstOpen", () => {
  it("writes the time once per login and challenge, under the module's key", async () => {
    m.upstashPipeline.mockResolvedValue([{ result: 1 }]);
    await recordFirstOpen("classic", "Alice", "web-1");
    await recordFirstOpen("ai", "Alice", "jail-1");
    const [[classic]] = m.upstashPipeline.mock.calls[0];
    const [[ai]] = m.upstashPipeline.mock.calls[1];
    expect(classic.slice(0, 3)).toEqual(["HSETNX", "ctf:classic:opened:Alice", "web-1"]);
    expect(ai.slice(0, 3)).toEqual(["HSETNX", "ctf:ai:opened:Alice", "jail-1"]);
    expect(Number.isNaN(Date.parse(classic[3]))).toBe(false);
  });

  it("never throws: a transport failure and a per-command error are logged and swallowed", async () => {
    m.upstashPipeline.mockRejectedValueOnce(new Error("Upstash pipeline failed: HTTP 503"));
    await expect(recordFirstOpen("classic", "alice", "web-1")).resolves.toBeUndefined();
    m.upstashPipeline.mockResolvedValueOnce([{ error: "WRONGTYPE" }]);
    await expect(recordFirstOpen("classic", "alice", "web-1")).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledTimes(2);
  });
});
