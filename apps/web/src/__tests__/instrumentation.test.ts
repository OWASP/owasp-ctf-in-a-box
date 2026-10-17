// Next's server-startup hook (#590). What this pins: the announcer starts
// ONLY in the nodejs runtime (the Edge copy of this file must never load the
// ticker's server-only stores), fire-and-forget — register() returns before
// the ticker module has even been imported, so a slow first tick cannot gate
// serving — and a boot where the ticker fails to load still serves.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ startAnnounceTicker: vi.fn() }));
vi.mock("@/lib/announce/ticker", () => ({ startAnnounceTicker: mocks.startAnnounceTicker }));

import { register } from "@/instrumentation";

/** A few macrotasks: long enough for a mocked dynamic import to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

let savedRuntime: string | undefined;

beforeEach(() => {
  savedRuntime = process.env.NEXT_RUNTIME;
  mocks.startAnnounceTicker.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  if (savedRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = savedRuntime;
  vi.restoreAllMocks();
});

describe("register()", () => {
  it("starts the announcer in the nodejs runtime", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    register();
    await vi.waitFor(() => expect(mocks.startAnnounceTicker).toHaveBeenCalledTimes(1));
  });

  it("does NOT start it outside the nodejs runtime (the Edge copy must not load the stores)", async () => {
    process.env.NEXT_RUNTIME = "edge";
    register();
    await settle();
    expect(mocks.startAnnounceTicker).not.toHaveBeenCalled();

    delete process.env.NEXT_RUNTIME;
    register();
    await settle();
    expect(mocks.startAnnounceTicker).not.toHaveBeenCalled();
  });

  // register() runs before the first request is served; awaiting the ticker
  // import inside it would put a dynamic import on the serving path.
  it("returns BEFORE the announcer has loaded — startup is fire-and-forget", () => {
    process.env.NEXT_RUNTIME = "nodejs";
    expect(register()).toBeUndefined();
    expect(mocks.startAnnounceTicker).not.toHaveBeenCalled();
  });

  it("a ticker that throws on start is logged, not propagated — the boot still serves", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    mocks.startAnnounceTicker.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(() => register()).not.toThrow();
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith("ctf-app: discord announcer not started:", "boom"));
  });
});
