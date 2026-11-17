import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { register } from "@/instrumentation";

const LINE =
  "[startup] Secure Development is on (SCORE_IMAGE is set) but GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET are missing: players cannot link GitHub, so no PR will score.";

let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  err = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("BETTER_AUTH_URL", "https://ctf.example.org");
  vi.stubEnv("GITHUB_CLIENT_ID", "");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "");
});
afterEach(() => {
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
