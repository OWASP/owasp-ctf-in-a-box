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
      new Error("legacy Redis data detected"),
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
      "ctf-app: Redis compatibility check failed: Error: legacy Redis data detected",
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
