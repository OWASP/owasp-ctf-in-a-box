// /reset: where a player redeems an organizer's reset code. The form has its
// own suite; this pins what the page says around it and that it mounts it.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/reset-password-form", () => ({
  default: () => <form data-testid="reset-password-form" />,
}));

import ResetPage, { metadata } from "@/app/(site)/reset/page";

const html = renderToStaticMarkup(<ResetPage />);

describe("/reset page", () => {
  it("names the page", () => {
    expect(html).toContain("Reset password");
    expect(metadata.title).toBe("Reset password");
  });

  it("says how codes work", () => {
    expect(html).toContain("Enter the reset code an organizer gave you and choose a new password.");
    expect(html).toContain("Codes work once and expire after 15 minutes.");
  });

  it("mounts the reset form", () => {
    expect(html).toContain('data-testid="reset-password-form"');
  });
});
