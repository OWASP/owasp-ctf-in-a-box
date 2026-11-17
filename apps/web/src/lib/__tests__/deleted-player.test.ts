// The deleted-player marker's key names are a contract with the scorer, which
// pins the same literals in scorer/test/store.test.js: a
// rename on one side only would let a deleted player's score through.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upstashEval: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval: mocks.upstashEval }));

import {
  AUTH_USER_ROWS_KEY,
  DELETED_PREFIX,
  MARK_DELETING_SCRIPT,
  RESTORE_AFTER_FAILED_DELETE_SCRIPT,
  deletedKey,
  markDeleting,
  restoreAfterFailedDelete,
} from "@/lib/deleted-player";

const ID = "0c7aca70-0000-4000-8000-00000000000a";

beforeEach(() => mocks.upstashEval.mockReset());

describe("deleted-player keys", () => {
  it("pins the literal marker prefix and account rows key the scorer reads", () => {
    expect(DELETED_PREFIX).toBe("ctf:deleted:");
    expect(deletedKey(ID)).toBe(`ctf:deleted:${ID}`);
    expect(AUTH_USER_ROWS_KEY).toBe("ctf:auth:user");
  });
});

describe("markDeleting", () => {
  it("sets the marker to pending:<fresh token> and returns the token", async () => {
    mocks.upstashEval.mockResolvedValue(1);
    const a = await markDeleting(ID);
    const b = await markDeleting(ID);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).not.toBe(a);
    expect(mocks.upstashEval).toHaveBeenNthCalledWith(1, MARK_DELETING_SCRIPT, [`ctf:deleted:${ID}`], [a]);
    expect(MARK_DELETING_SCRIPT).toContain("'pending:' .. ARGV[1]");
  });

  it("throws on an unconfirmed mark", async () => {
    mocks.upstashEval.mockResolvedValue(null);
    await expect(markDeleting(ID)).rejects.toThrow(/not set/);
  });
});

describe("restoreAfterFailedDelete", () => {
  it("hands the script the marker, the rows key, the id and the token", async () => {
    mocks.upstashEval.mockResolvedValue("restored");
    await expect(restoreAfterFailedDelete(ID, "tok")).resolves.toBe("restored");
    expect(mocks.upstashEval).toHaveBeenCalledWith(
      RESTORE_AFTER_FAILED_DELETE_SCRIPT,
      [`ctf:deleted:${ID}`, "ctf:auth:user"],
      [ID, "tok"],
    );
  });

  it("passes kept through and throws on any other reply", async () => {
    mocks.upstashEval.mockResolvedValueOnce("kept");
    await expect(restoreAfterFailedDelete(ID, "tok")).resolves.toBe("kept");
    mocks.upstashEval.mockResolvedValueOnce(1);
    await expect(restoreAfterFailedDelete(ID, "tok")).rejects.toThrow(/unexpected reply/);
  });
});
