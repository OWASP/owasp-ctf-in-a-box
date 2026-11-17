// Delete all accounts, beside master reset in the Event tab's Danger zone.
// The confirm is type-gated; the action is one DELETE and, on success, a
// sign-out and a full navigation to sign-in on the way to /admin/claim: the
// grants and the account are gone, so the SPA's own routes would 403 and the
// cached session must not reach the claim form.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut } }));

import { createDangerActions, deleteAllAccountsConfirm } from "@/app/(site)/admin/admin-danger-actions";

describe("deleteAllAccountsConfirm", () => {
  it("requires the typed phrase and says what survives", () => {
    const c = deleteAllAccountsConfirm();
    expect(c.requireType).toBe("delete all accounts");
    expect(c.danger).toBe(true);
    expect(c.body).toBe(
      "Deletes every account, including yours, every admin grant, and all progress. /admin stays closed until someone claims it with a new claim code: rotate it first (ctf-setup.sh admin-code, or deploy.sh --new-admin-code).",
    );
  });
});

describe("doDeleteAllAccounts", () => {
  beforeEach(() => {
    signOut.mockReset();
    signOut.mockResolvedValue({});
  });
  afterEach(() => vi.unstubAllGlobals());
  const make = () => {
    const setError = vi.fn();
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    const actions = createDangerActions({
      setError,
      setResetInfo: vi.fn(),
      setSettings: vi.fn(),
      restampNow: vi.fn(),
    });
    return { actions, setError, assign };
  };

  it("sends the typed phrase, signs out and navigates to sign-in bound for /admin/claim", async () => {
    const { actions, assign } = make();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cleared: { keys: 4 } }) });
    vi.stubGlobal("fetch", fetchMock);
    await actions.doDeleteAllAccounts("delete all accounts");
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/ops/accounts", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "delete all accounts" }),
    });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/sign-in?next=%2Fadmin%2Fclaim");
    expect(signOut.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0]);
  });

  it("still navigates when the sign-out fails", async () => {
    const { actions, assign } = make();
    signOut.mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    await actions.doDeleteAllAccounts("delete all accounts");
    expect(assign).toHaveBeenCalledWith("/sign-in?next=%2Fadmin%2Fclaim");
  });

  it("reports a refusal and stays put", async () => {
    const { actions, setError, assign } = make();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "nope" }) }));
    await actions.doDeleteAllAccounts("x");
    expect(setError).toHaveBeenLastCalledWith("nope");
    expect(signOut).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
