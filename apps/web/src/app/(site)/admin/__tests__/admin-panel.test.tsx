// The Forbidden wall's notices. With nobody claimed, the wall is the one
// surface an organizer sees, so it says how to get in. Only booleans cross
// into the render: never the claim-code hash, never the roster.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const VECTOR_HASH = "3eb1bd439947eb762998e566ccc2e099c791118b2f40579cc4f7da2b5061b7f9";
const NO_ADMINS =
  "No organizer has claimed this box yet. Open /admin/claim and enter the admin claim code from setup.";
const NO_HASH =
  "ADMIN_CLAIM_CODE_HASH is not set or is not a SHA-256 — run ./setup/ctf-setup.sh admin-code (or redeploy with --new-admin-code) and restart the app.";

const { requireAdmin, countAdminGrants } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  countAdminGrants: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin }));
vi.mock("@/lib/admin-grants", () => ({ countAdminGrants }));

import AdminPanel from "@/app/(site)/admin/admin-panel";

const render = async () => renderToStaticMarkup(await AdminPanel({}));

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue({ ok: false, status: 403 });
  countAdminGrants.mockResolvedValue(1);
  vi.stubEnv("ADMIN_CLAIM_CODE_HASH", VECTOR_HASH);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("admin panel Forbidden wall", () => {
  it("points every refused viewer at /admin/claim, with no notice when admins exist", async () => {
    const html = await render();
    expect(html).toMatch(/organizer/i);
    expect(html).toContain('href="/admin/claim"');
    expect(html).not.toContain(NO_ADMINS);
  });

  it("says nobody has claimed the box yet", async () => {
    countAdminGrants.mockResolvedValue(0);
    const html = await render();
    expect(html).toContain(NO_ADMINS);
    expect(html).not.toContain("ADMIN_CLAIM_CODE_HASH is not set");
  });

  it("adds the hash notice when the hash is unset and nobody has claimed", async () => {
    countAdminGrants.mockResolvedValue(0);
    vi.stubEnv("ADMIN_CLAIM_CODE_HASH", "");
    expect(await render()).toContain(NO_HASH);
  });

  it("treats a pasted code as unset", async () => {
    countAdminGrants.mockResolvedValue(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("ADMIN_CLAIM_CODE_HASH", "0123-4567-89ab-cdef-0123-4567-89ab-cdef");
    const html = await render();
    expect(html).toContain(NO_HASH);
    expect(html).not.toContain("0123-4567");
    warn.mockRestore();
  });

  it("never renders the hash", async () => {
    countAdminGrants.mockResolvedValue(0);
    expect(await render()).not.toContain(VECTOR_HASH);
  });

  it("still renders the wall, without a notice, when the count read fails", async () => {
    countAdminGrants.mockRejectedValue(new Error("redis down"));
    const html = await render();
    expect(html).toMatch(/organizer/i);
    expect(html).not.toContain(NO_ADMINS);
    expect(html).not.toContain(NO_HASH);
  });
});
