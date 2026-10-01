// The write half of runtime admin grants (issue #147): validation and the
// add/remove script's arguments. The Upstash seam is mocked, so this pins the
// contract this module has with Redis, not Redis itself.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { upstashEval, upstashPipeline } = vi.hoisted(() => ({
  upstashEval: vi.fn(),
  upstashPipeline: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval, upstashPipeline }));

import { addStoredAdmin, removeStoredAdmin, AdminValidationError, ADMIN_ADMINS_KEY } from "@/lib/admin-store";
import { listStoredAdmins } from "@/lib/admin-admins";

beforeEach(() => {
  vi.clearAllMocks();
  upstashEval.mockResolvedValue([]);
  upstashPipeline.mockResolvedValue([{ result: [] }]);
});

describe("listStoredAdmins", () => {
  it("lowercases and sorts, so membership tests are order- and case-stable", async () => {
    upstashPipeline.mockResolvedValue([{ result: ["Zed", "alice", "BOB"] }]);
    expect(await listStoredAdmins()).toEqual(["alice", "bob", "zed"]);
  });

  it("propagates a store failure rather than returning an empty list", async () => {
    // An empty list reads as "not an admin" — the right answer for the wrong
    // reason. requireAdmin catches this explicitly and denies.
    upstashPipeline.mockRejectedValue(new Error("redis down"));
    await expect(listStoredAdmins()).rejects.toThrow("redis down");
  });
});

describe("validation", () => {
  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["not a login", "spaces"],
    ["-leading", "leading hyphen"],
    ["trailing-", "trailing hyphen"],
    ["double--hyphen", "consecutive hyphens"],
    ["a".repeat(40), "too long"],
    ["bad_underscore", "underscore"],
  ])("refuses %j (%s) before writing anything", async (login) => {
    await expect(addStoredAdmin(login, "alice")).rejects.toBeInstanceOf(AdminValidationError);
    expect(upstashEval).not.toHaveBeenCalled();
  });

  it.each([["alice"], ["a"], ["with-hyphen"], ["Mixed-Case-9"], ["a".repeat(39)]])(
    "accepts %j",
    async (login) => {
      await expect(addStoredAdmin(login, "alice")).resolves.toBeDefined();
    },
  );
});

describe("mutations", () => {
  it("normalizes to lowercase so a grant matches the session compare", async () => {
    await addStoredAdmin("  CaRoL  ", "alice");
    const [, , argv] = upstashEval.mock.calls[0];
    expect(argv[0]).toBe("add");
    expect(argv[1]).toBe("carol");
  });

  it("writes the audit line in the same call as the grant", async () => {
    // One script, so a grant can never land without its record — the same
    // guarantee updateAdminSettings gives.
    await addStoredAdmin("dave", "alice");
    const [, keys, argv] = upstashEval.mock.calls[0];
    expect(keys[0]).toBe(ADMIN_ADMINS_KEY);
    const audit = JSON.parse(argv[2] as string);
    expect(audit).toMatchObject({ by: "alice", action: "admin:add", login: "dave" });
    expect(typeof audit.at).toBe("string");
  });

  it("records a removal distinctly from a grant", async () => {
    await removeStoredAdmin("carol", "alice");
    const [, , argv] = upstashEval.mock.calls[0];
    expect(argv[0]).toBe("remove");
    expect(JSON.parse(argv[2] as string).action).toBe("admin:remove");
  });

  it("returns the resulting set, lowercased and sorted", async () => {
    upstashEval.mockResolvedValue(["Zed", "carol"]);
    expect(await addStoredAdmin("zed", "alice")).toEqual(["carol", "zed"]);
  });
});

// #499: the doc comment always said this THROWS on a failed read, so that
// requireAdmin denies for the right reason; an error REPLY used to resolve as
// an empty roster instead.
describe("listStoredAdmins on an error reply", () => {
  it("throws instead of reading as no stored admins", async () => {
    upstashPipeline.mockResolvedValueOnce([{ error: "NOAUTH" }]);
    await expect(listStoredAdmins()).rejects.toThrow(/NOAUTH/);
  });
});
