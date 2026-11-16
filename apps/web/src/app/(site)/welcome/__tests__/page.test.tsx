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
vi.mock("@/components/username-pick-form", () => ({
  default: ({ next }: { next: string }) => <div data-next={next} />,
}));

import WelcomePage from "@/app/(site)/welcome/page";

const params = (next?: string) => ({ searchParams: Promise.resolve(next === undefined ? {} : { next }) });

beforeEach(() => vi.clearAllMocks());

describe("/welcome", () => {
  it("sends a signed-out visitor home", async () => {
    getPlayer.mockResolvedValue(null);
    await expect(WelcomePage(params("/quiz"))).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("sends a player who already has a username on to the sanitized next", async () => {
    getPlayer.mockResolvedValue({ id: "p", username: "bob" });
    await expect(WelcomePage(params("/flags"))).rejects.toThrow("NEXT_REDIRECT:/flags");
    await expect(WelcomePage(params("//evil"))).rejects.toThrow("NEXT_REDIRECT:/profile");
  });

  it("asks a player with no username to pick one, with the exact copy and the sanitized next", async () => {
    getPlayer.mockResolvedValue({ id: "p", username: null });
    const html = renderToStaticMarkup(await WelcomePage(params("/\\evil")));
    expect(html).toContain("Pick a username");
    expect(html).toContain("This is the name other players see on the leaderboard and team pages.");
    expect(html).toContain('data-next="/profile"');
    expect(redirect).not.toHaveBeenCalled();
  });
});
