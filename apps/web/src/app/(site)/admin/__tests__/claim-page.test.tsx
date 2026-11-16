// /admin/claim's three states, rendered statically: signed out, already an
// admin, and a signed-in player who may claim.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const m = vi.hoisted(() => ({ getPlayer: vi.fn(), isAdminPlayer: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/player", () => ({ getPlayer: m.getPlayer }));
vi.mock("@/lib/admin-auth", () => ({ isAdminPlayer: m.isAdminPlayer }));

import AdminClaimPage from "@/app/(site)/admin/claim/page";
import { claimErrorText } from "@/app/(site)/admin/claim/claim-form";
import { CLAIM_INVALID } from "@/lib/admin-claim-copy";

const player = { id: "0b9e4f3c-1d2a-4c5b-8e6f-7a8b9c0d1e2f", name: "Alice", image: null, githubLogin: null };

beforeEach(() => {
  vi.clearAllMocks();
  m.isAdminPlayer.mockResolvedValue(false);
});

describe("/admin/claim", () => {
  it("asks a signed-out visitor to sign in first, with no form", async () => {
    m.getPlayer.mockResolvedValue(null);
    const html = renderToStaticMarkup(await AdminClaimPage());
    expect(html).toContain("Sign in first");
    expect(html).not.toContain("<form");
  });

  it("points an admin at /admin", async () => {
    m.getPlayer.mockResolvedValue(player);
    m.isAdminPlayer.mockResolvedValue(true);
    const html = renderToStaticMarkup(await AdminClaimPage());
    expect(html).toContain('href="/admin"');
    expect(html).not.toContain("<form");
  });

  it("shows a signed-in non-admin the form with a labelled code field", async () => {
    m.getPlayer.mockResolvedValue(player);
    const html = renderToStaticMarkup(await AdminClaimPage());
    expect(html).toContain("<form");
    expect(html).toMatch(/<label[^>]*for="admin-claim-code"[^>]*>Admin claim code<\/label>/);
    expect(html).toMatch(/<input[^>]*id="admin-claim-code"[^>]*autoComplete="off"|<input[^>]*autoComplete="off"[^>]*id="admin-claim-code"/i);
  });

  it("still offers the form when the admin check fails", async () => {
    m.getPlayer.mockResolvedValue(player);
    m.isAdminPlayer.mockRejectedValue(new Error("redis down"));
    const html = renderToStaticMarkup(await AdminClaimPage());
    expect(html).toContain("<form");
  });
});

describe("claimErrorText", () => {
  it("shows the one fixed refusal for a 400 and a wait for a 429", () => {
    expect(claimErrorText(400, null)).toBe(CLAIM_INVALID);
    expect(claimErrorText(429, "600")).toContain("10 minutes");
    expect(claimErrorText(503, null)).toMatch(/try again/i);
  });
});
