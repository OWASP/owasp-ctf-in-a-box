// setUsernameOnce against a faked internal adapter: the decision table and
// the error mapping. The unique-index race itself is pinned by
// username-store.upstash.test.ts against a real Redis.

import { beforeEach, describe, expect, it, vi } from "vitest";

const adapter = vi.hoisted(() => ({
  findUserById: vi.fn<(id: string) => Promise<Record<string, unknown> | null>>(),
  updateUser: vi.fn<(id: string, data: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { $context: Promise.resolve({ internalAdapter: adapter }) } }));

import { setUsernameOnce } from "@/lib/username-store";

const ID = "0b9e4f3c-1d2a-4c5b-8e6f-7a8b9c0d1e2f";

beforeEach(() => {
  vi.clearAllMocks();
  adapter.findUserById.mockResolvedValue({ id: ID, username: null });
  adapter.updateUser.mockResolvedValue({ id: ID });
});

describe("setUsernameOnce", () => {
  it("stores the normalized username and the typed display form", async () => {
    expect(await setUsernameOnce(ID, "  Bob_1 ")).toBe("ok");
    expect(adapter.updateUser).toHaveBeenCalledWith(ID, { username: "bob_1", displayUsername: "Bob_1" });
  });

  it.each(["ab", "x".repeat(31), "bad name", "bob!", "Kate"])("refuses %j as invalid without touching the store", async (raw) => {
    expect(await setUsernameOnce(ID, raw)).toBe("invalid");
    expect(adapter.findUserById).not.toHaveBeenCalled();
    expect(adapter.updateUser).not.toHaveBeenCalled();
  });

  it("answers already_set when the user has a username, writing nothing", async () => {
    adapter.findUserById.mockResolvedValue({ id: ID, username: "alice" });
    expect(await setUsernameOnce(ID, "bob")).toBe("already_set");
    expect(adapter.updateUser).not.toHaveBeenCalled();
  });

  it("maps the adapter's unique-taken failure to taken", async () => {
    adapter.updateUser.mockRejectedValue(new Error("auth store: update user failed: unique email, username taken"));
    expect(await setUsernameOnce(ID, "bob")).toBe("taken");
  });

  it("lets any other failure throw", async () => {
    adapter.updateUser.mockRejectedValue(new Error("auth store: update user failed: NOAUTH"));
    await expect(setUsernameOnce(ID, "bob")).rejects.toThrow("NOAUTH");
    adapter.findUserById.mockRejectedValue(new Error("boom"));
    await expect(setUsernameOnce(ID, "carol")).rejects.toThrow("boom");
  });

  it("throws when the user row does not exist", async () => {
    adapter.findUserById.mockResolvedValue(null);
    await expect(setUsernameOnce(ID, "bob")).rejects.toThrow();
  });
});
