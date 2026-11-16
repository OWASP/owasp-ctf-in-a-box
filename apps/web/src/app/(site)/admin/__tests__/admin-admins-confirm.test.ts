// Removing an admin asks first, through the panel's own dialog. The target is
// a player id with a display name; "is this me" compares ids, never names.
import { describe, expect, it } from "vitest";
import { adminRemoveConfirm } from "@/app/(site)/admin/admin-admins-tab";

const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = { id: "00000000-0000-4000-8000-000000000002", name: "Octo Cat" };

describe("adminRemoveConfirm", () => {
  it("names the person being removed, and what they lose", () => {
    const { title, body, confirmLabel } = adminRemoveConfirm(OTHER, ME);
    expect(title).toBe("Remove Octo Cat as an admin?");
    expect(body).toContain("Octo Cat");
    expect(body).toMatch(/immediately/);
    expect(confirmLabel).toBe("Remove admin");
  });

  it("says how to undo it: a new code", () => {
    expect(adminRemoveConfirm(OTHER, ME).body).toMatch(/new code/);
  });

  it("keeps the sharper sentence for removing yourself", () => {
    const { title, body } = adminRemoveConfirm({ id: ME, name: "Me" }, ME);
    expect(title).toBe("Remove your own admin access?");
    expect(body).toBe("You will lose this panel immediately. Another admin can issue you a new code.");
  });

  it("decides self by id, not by a matching display name", () => {
    expect(adminRemoveConfirm({ id: OTHER.id, name: "Me" }, ME).title).toBe("Remove Me as an admin?");
  });
});
