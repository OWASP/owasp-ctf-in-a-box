import { beforeEach, describe, expect, it, vi } from "vitest";

const upstashPipeline = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline }));

import { accountExists } from "@/lib/account-exists";

const ID = "0b9e4f3c-1d2a-4c5b-8e6f-7a8b9c0d1e2f";

beforeEach(() => upstashPipeline.mockReset());

describe("accountExists (#822)", () => {
  it("asks HEXISTS on the user rows hash for exactly that id", async () => {
    upstashPipeline.mockResolvedValue([{ result: 1 }]);
    expect(await accountExists(ID)).toBe(true);
    expect(upstashPipeline).toHaveBeenCalledWith([["HEXISTS", "ctf:auth:user", ID]]);
  });

  it("is false when the row is gone", async () => {
    upstashPipeline.mockResolvedValue([{ result: 0 }]);
    expect(await accountExists(ID)).toBe(false);
  });

  it("throws on a per-command error instead of reading it as gone or present", async () => {
    upstashPipeline.mockResolvedValue([{ error: "NOAUTH" }]);
    await expect(accountExists(ID)).rejects.toThrow(/HEXISTS failed: NOAUTH/);
    upstashPipeline.mockResolvedValue([]);
    await expect(accountExists(ID)).rejects.toThrow(/no reply/);
  });
});
