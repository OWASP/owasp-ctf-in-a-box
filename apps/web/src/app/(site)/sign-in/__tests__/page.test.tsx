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
vi.mock("@/components/password-auth-form", () => ({
  default: ({ next }: { next: string }) => <div data-next={next} />,
}));

import SignInPage from "@/app/(site)/sign-in/page";

beforeEach(() => vi.clearAllMocks());

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
});
