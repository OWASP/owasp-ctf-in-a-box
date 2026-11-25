import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkRedisCompatibility: vi.fn(),
}));

vi.mock("@/lib/redis-compatibility", () => ({
  checkRedisCompatibility: mocks.checkRedisCompatibility,
}));

import { registerNodeInstrumentation } from "@/instrumentation.node";

describe("registerNodeInstrumentation()", () => {
  beforeEach(() => {
    mocks.checkRedisCompatibility.mockReset();
    mocks.checkRedisCompatibility.mockResolvedValue(undefined);
  });

  it("continues startup when Redis compatibility validation succeeds", async () => {
    const exit = vi.fn(() => {
      throw new Error("unexpected exit");
    });
    const logErr = vi.fn();

    await expect(
      registerNodeInstrumentation({ exit, logErr }),
    ).resolves.toBeUndefined();

    expect(mocks.checkRedisCompatibility).toHaveBeenCalledTimes(1);
    expect(logErr).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("logs the compatibility failure once and exits non-zero", async () => {
    mocks.checkRedisCompatibility.mockRejectedValueOnce(
      Object.assign(new Error("legacy Redis data detected"), { name: "IncompatibleRedisError" }),
    );

    const exit = vi.fn((code: number) => {
      throw new Error(`process exit ${code}`);
    });
    const logErr = vi.fn();

    await expect(
      registerNodeInstrumentation({ exit, logErr }),
    ).rejects.toThrow("process exit 1");

    expect(logErr).toHaveBeenCalledTimes(1);
    expect(logErr).toHaveBeenCalledWith(
      "ctf-app: Redis compatibility check failed: IncompatibleRedisError: legacy Redis data detected",
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("waits for a Redis that is not answering yet with its own log line, then continues (#825)", async () => {
    mocks.checkRedisCompatibility
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(undefined);
    const exit = vi.fn(() => {
      throw new Error("unexpected exit");
    });
    const logErr = vi.fn();
    const sleep = vi.fn(async () => {});

    await expect(registerNodeInstrumentation({ exit, logErr, sleep })).resolves.toBeUndefined();

    expect(mocks.checkRedisCompatibility).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(logErr).toHaveBeenCalledExactlyOnceWith("ctf-app: waiting for Redis (Error: fetch failed), retrying");
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits with a distinct line when Redis never answers (#825)", async () => {
    mocks.checkRedisCompatibility.mockRejectedValue(new Error("fetch failed"));
    const exit = vi.fn((code: number) => {
      throw new Error(`process exit ${code}`);
    });
    const logErr = vi.fn();

    await expect(registerNodeInstrumentation({ exit, logErr, sleep: async () => {}, tries: 3 })).rejects.toThrow("process exit 1");

    expect(logErr).toHaveBeenLastCalledWith("ctf-app: Redis did not answer after 3 tries: Error: fetch failed");
    expect(logErr.mock.calls.some(([m]) => /compatibility check failed/.test(String(m)))).toBe(false);
  });
});

