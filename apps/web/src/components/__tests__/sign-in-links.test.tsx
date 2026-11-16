// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { useSession } = vi.hoisted(() => ({ useSession: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: { useSession, signIn: { social: vi.fn() } } }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import AuthNav from "@/components/auth-nav";
import HeroCta from "@/components/hero-cta";
import JoinTeamInvite from "@/components/join-team-invite";

afterEach(cleanup);

describe("sign-in entry points", () => {
  it("signed-out nav links to the sign-in page", async () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    render(<AuthNav />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const link = screen.getByRole("link", { name: /sign-in/ });
    expect(link.getAttribute("href")).toBe("/sign-in?next=%2Fprofile");
  });

  it("the hero sign-in CTA links to the sign-in page with its own destination", () => {
    render(<HeroCta label="Sign in and play" signIn callbackURL="/flags" />);
    const link = screen.getByRole("link", { name: "Sign in and play" });
    expect(link.getAttribute("href")).toBe("/sign-in?next=%2Fflags");
  });

  it("the join invite links signed-out visitors back to this invite after sign-in", () => {
    render(<JoinTeamInvite code="ABC 123" teamName="Red" signedIn={false} alreadyOnTeam={false} />);
    const link = screen.getByRole("link", { name: /sign-in/ });
    expect(link.getAttribute("href")).toBe("/sign-in?next=%2Fjoin%2FABC%2520123");
  });
});
