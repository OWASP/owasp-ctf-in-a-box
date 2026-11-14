// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { linkSocial } = vi.hoisted(() => ({ linkSocial: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: { linkSocial } }));

import LinkGithubButton from "@/components/link-github-button";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LinkGithubButton", () => {
  it("links GitHub with no scopes, returning to the profile marker on success and failure", () => {
    linkSocial.mockResolvedValue({});
    render(<LinkGithubButton />);
    fireEvent.click(screen.getByRole("button", { name: "Link GitHub account" }));
    expect(linkSocial).toHaveBeenCalledTimes(1);
    expect(linkSocial).toHaveBeenCalledWith({
      provider: "github",
      callbackURL: "/profile?linked=github",
      errorCallbackURL: "/profile?linked=github",
    });
  });

  it("uses the callbackURL it is given for both legs", () => {
    linkSocial.mockResolvedValue({});
    render(<LinkGithubButton callbackURL="/somewhere?linked=github" />);
    fireEvent.click(screen.getByRole("button", { name: "Link GitHub account" }));
    expect(linkSocial).toHaveBeenCalledWith({
      provider: "github",
      callbackURL: "/somewhere?linked=github",
      errorCallbackURL: "/somewhere?linked=github",
    });
  });

  it("shows a retry message when linkSocial resolves with an error", async () => {
    linkSocial.mockResolvedValue({ error: { message: "x" } });
    render(<LinkGithubButton />);
    fireEvent.click(screen.getByRole("button", { name: "Link GitHub account" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Linking GitHub didn't finish. Try again.");
  });
});
