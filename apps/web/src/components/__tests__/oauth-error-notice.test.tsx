// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { signInSocial } = vi.hoisted(() => ({ signInSocial: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: { signIn: { social: signInSocial } } }));

import OAuthErrorNotice from "@/components/oauth-error-notice";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OAuthErrorNotice retry", () => {
  it("links to the sign-in page carrying the destination, starting no provider flow", () => {
    render(<OAuthErrorNotice error="access_denied" callbackURL="/flags" />);
    const link = screen.getByRole("link", { name: "Try again" });
    expect(link.getAttribute("href")).toBe("/sign-in?next=%2Fflags");
    expect(signInSocial).not.toHaveBeenCalled();
  });

  it("sanitizes an unsafe destination", () => {
    render(<OAuthErrorNotice error="access_denied" callbackURL="//evil" />);
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/sign-in?next=%2Fprofile");
  });
});

describe("OAuthErrorNotice provider-switch refusals", () => {
  it("names a PROVIDER_DISABLED refusal", () => {
    render(<OAuthErrorNotice error="PROVIDER_DISABLED" />);
    expect(screen.getByRole("alert").textContent).toContain("That sign-in option is not available.");
  });

  it("names a SIGN_IN_SETTINGS_UNREADABLE refusal", () => {
    render(<OAuthErrorNotice error="SIGN_IN_SETTINGS_UNREADABLE" />);
    expect(screen.getByRole("alert").textContent).toContain("Sign-in options could not be loaded. Try again.");
  });
});
