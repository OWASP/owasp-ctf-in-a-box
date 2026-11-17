import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { getPlayer, redirect } = vi.hoisted(() => ({
  getPlayer: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/player", () => ({ getPlayer }));
const { getAdminSettings, enabledSignInProviders } = vi.hoisted(() => ({
  getAdminSettings: vi.fn(),
  enabledSignInProviders: vi.fn(),
}));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings }));
vi.mock("@/lib/sign-in-providers", () => ({ enabledSignInProviders }));
vi.mock("@/components/password-auth-form", () => ({
  default: ({ next, providers }: { next: string; providers: string[] }) => (
    <div data-next={next} data-providers={providers.join(",")} />
  ),
}));

import SignInPage from "@/app/(site)/sign-in/page";

beforeEach(() => {
  vi.clearAllMocks();
  getAdminSettings.mockResolvedValue({ signInProviders: {} });
  enabledSignInProviders.mockReturnValue([]);
});

describe("/sign-in", () => {
  it("sends a signed-in visitor to their sanitized destination", async () => {
    getPlayer.mockResolvedValue({ id: "p" });
    await expect(SignInPage({ searchParams: Promise.resolve({ next: "/flags" }) })).rejects.toThrow("NEXT_REDIRECT:/flags");
    await expect(SignInPage({ searchParams: Promise.resolve({ next: "//evil" }) })).rejects.toThrow("NEXT_REDIRECT:/profile");
  });

  it("shows the form with the sanitized next to a signed-out visitor", async () => {
    getPlayer.mockResolvedValue(null);
    const html = renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({ next: "/\\evil" }) }));
    expect(html).toContain('data-next="/profile"');
    expect(redirect).not.toHaveBeenCalled();
  });

  it("hands the form the enabled providers", async () => {
    getPlayer.mockResolvedValue(null);
    enabledSignInProviders.mockReturnValue(["github", "google"]);
    const html = renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('data-providers="github,google"');
  });

  it("renders the form with no providers when the settings read throws", async () => {
    getPlayer.mockResolvedValue(null);
    getAdminSettings.mockRejectedValue(new Error("redis down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('data-providers=""');
  });
});
