// Issue #740: Delete all accounts, beside master reset in the Event tab's
// Danger zone. The confirm is type-gated; the action is one DELETE and, on
// success, a full navigation to /admin/claim (the grants are gone, so the
// SPA's own routes would 403).
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("sends the typed phrase and navigates to /admin/claim", async () => {
    const { actions, assign } = make();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cleared: { keys: 4 } }) });
    vi.stubGlobal("fetch", fetchMock);
    await actions.doDeleteAllAccounts("delete all accounts");
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/ops/accounts", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "delete all accounts" }),
    });
    expect(assign).toHaveBeenCalledWith("/admin/claim");
  });

  it("reports a refusal and stays put", async () => {
    const { actions, setError, assign } = make();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "nope" }) }));
    await actions.doDeleteAllAccounts("x");
    expect(setError).toHaveBeenLastCalledWith("nope");
    expect(assign).not.toHaveBeenCalled();
  });
});
