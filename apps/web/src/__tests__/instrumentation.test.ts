import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startAnnounceTicker: vi.fn(),
  registerNodeInstrumentation: vi.fn(),
}));

vi.mock("@/lib/announce/ticker", () => ({
  startAnnounceTicker: mocks.startAnnounceTicker,
}));

vi.mock("@/instrumentation.node", () => ({
  registerNodeInstrumentation: mocks.registerNodeInstrumentation,
}));

import { register } from "@/instrumentation";

const LINE =
  "[startup] Secure Development is on (SCORE_IMAGE is set) but GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET are missing: players cannot link GitHub, so no PR will score.";

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
  vi.stubEnv("NEXT_RUNTIME", "edge");

  mocks.startAnnounceTicker.mockReset();
  mocks.registerNodeInstrumentation.mockReset();
  mocks.registerNodeInstrumentation.mockResolvedValue(undefined);
});

afterEach(() => {
  if (savedRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = savedRuntime;

  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("instrumentation GitHub keys guard", () => {
  it("logs once when SCORE_IMAGE is set and GitHub has no keys, without throwing", async () => {
    vi.stubEnv("SCORE_IMAGE", "x");

    await expect(register()).resolves.toBeUndefined();

    expect(err.mock.calls.filter((c: unknown[]) => c[0] === LINE)).toHaveLength(1);
  });

  it("is silent when the GitHub keys are present", async () => {
    vi.stubEnv("SCORE_IMAGE", "x");
    vi.stubEnv("GITHUB_CLIENT_ID", "id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "secret");

    await register();

    expect(err.mock.calls.flat()).not.toContain(LINE);
  });

  it("is silent when there is no scorer image", async () => {
    vi.stubEnv("SCORE_IMAGE", "  ");

    await register();

    expect(err.mock.calls.flat()).not.toContain(LINE);
  });
});

describe("register() announcer", () => {
  it("checks Redis compatibility before starting the announcer in Node.js", async () => {
    process.env.NEXT_RUNTIME = "nodejs";

    await register();

    expect(mocks.registerNodeInstrumentation).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(mocks.startAnnounceTicker).toHaveBeenCalledTimes(1),
    );
  });

  it("does NOT check Redis or start the announcer outside Node.js", async () => {
    process.env.NEXT_RUNTIME = "edge";

    await register();
    await settle();

    expect(mocks.registerNodeInstrumentation).not.toHaveBeenCalled();
    expect(mocks.startAnnounceTicker).not.toHaveBeenCalled();

    delete process.env.NEXT_RUNTIME;

    await register();
    await settle();

    expect(mocks.registerNodeInstrumentation).not.toHaveBeenCalled();
    expect(mocks.startAnnounceTicker).not.toHaveBeenCalled();
  });

  it("returns a Promise for the mandatory asynchronous startup check", async () => {
    process.env.NEXT_RUNTIME = "nodejs";

    const startup = register();

    expect(startup).toBeInstanceOf(Promise);
    expect(mocks.startAnnounceTicker).not.toHaveBeenCalled();

    await startup;
  });

  it("does not start the announcer if Redis compatibility validation fails", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    mocks.registerNodeInstrumentation.mockRejectedValueOnce(
      new Error("legacy Redis schema detected"),
    );

    await expect(register()).rejects.toThrow("legacy Redis schema detected");

    expect(mocks.startAnnounceTicker).not.toHaveBeenCalled();
  });

  it("a ticker that throws on start is logged by label, not propagated", async () => {
    process.env.NEXT_RUNTIME = "nodejs";

    mocks.startAnnounceTicker.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    await register();

    await vi.waitFor(() =>
      expect(console.error).toHaveBeenCalledWith(
        "ctf-app: discord announcer not started:",
        "Error: boom",
      ),
    );
  });

  it("logs a fixed label for a non-Error throw, never the thrown value", async () => {
    process.env.NEXT_RUNTIME = "nodejs";

    mocks.startAnnounceTicker.mockImplementationOnce(() => {
      throw "FLAG{secret-in-a-thrown-string}";
    });

    await register();

    await vi.waitFor(() =>
      expect(console.error).toHaveBeenCalledWith(
        "ctf-app: discord announcer not started:",
        "non-Error throw",
      ),
    );

    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "FLAG{secret-in-a-thrown-string}",
    );
  });
});
