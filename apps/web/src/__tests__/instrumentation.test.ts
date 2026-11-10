import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Next's server-startup hook (#590): the announcer must start only in the
// nodejs runtime, fire-and-forget, and a load failure must not gate serving.
const mocks = vi.hoisted(() => ({ startAnnounceTicker: vi.fn() }));
vi.mock("@/lib/announce/ticker", () => ({ startAnnounceTicker: mocks.startAnnounceTicker }));

import { register } from "@/instrumentation";

const LINE =
  "[startup] Secure Development is on (SCORE_IMAGE is set) but GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET are missing: players cannot link GitHub, so no PR will score.";

/** A few macrotasks: long enough for a mocked dynamic import to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

let err: ReturnType<typeof vi.spyOn>;
let savedRuntime: string | undefined;

beforeEach(() => {
  err = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("BETTER_AUTH_URL", "https://ctf.example.org");
  vi.stubEnv("GITHUB_CLIENT_ID", "");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "");
  savedRuntime = process.env.NEXT_RUNTIME;
  mocks.startAnnounceTicker.mockReset();
});

afterEach(() => {
  if (savedRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = savedRuntime;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("instrumentation GitHub keys guard", () => {
  it("logs once when SCORE_IMAGE is set and GitHub has no keys, without throwing", () => {
    vi.stubEnv("SCORE_IMAGE", "x");
    expect(() => register()).not.toThrow();
    expect(err.mock.calls.filter((c: unknown[]) => c[0] === LINE)).toHaveLength(1);
  });

  it("is silent when the GitHub keys are present", () => {
    vi.stubEnv("SCORE_IMAGE", "x");
    vi.stubEnv("GITHUB_CLIENT_ID", "id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "secret");
    register();
    expect(err.mock.calls.flat()).not.toContain(LINE);
  });

  it("is silent when there is no scorer image", () => {
    vi.stubEnv("SCORE_IMAGE", "  ");
    register();
    expect(err.mock.calls.flat()).not.toContain(LINE);
  });
});

describe("register() announcer", () => {

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
