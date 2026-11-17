// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/auth-client", () => ({ authClient: {} }));

import ResetPasswordForm from "@/components/reset-password-form";
import { MISMATCH_COPY, PASSWORD_COPY } from "@/components/password-auth-form";
import { RESET_CODE_INVALID_COPY, RESET_DONE_COPY } from "@/lib/password-reset-copy";

const CODE = "0123-4567-89ab-cdef-0123-4567-89ab-cdef";
const PW = "correct horse battery";

function fill(password: string, confirm: string, response?: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response ?? new Response('{"ok":true}', { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<ResetPasswordForm />);
  fireEvent.change(screen.getByLabelText("Reset code"), { target: { value: CODE } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: confirm } });
  fireEvent.click(screen.getByRole("button", { name: /reset password/i }));
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ResetPasswordForm", () => {
  it("shows the mismatch copy and sends nothing", async () => {
    const f = fill(PW, `${PW}!`);
    expect(await screen.findByText(MISMATCH_COPY)).toBeTruthy();
    expect(f).not.toHaveBeenCalled();
  });

  it("shows the password copy for a short password and sends nothing", async () => {
    const f = fill("short", "short");
    // Once as the standing hint under the fields, once as the error.
    await waitFor(() => expect(screen.getAllByText(PASSWORD_COPY)).toHaveLength(2));
    expect(f).not.toHaveBeenCalled();
  });

  it("posts the code and password, then says so and links to sign in", async () => {
    const f = fill(PW, PW);
    expect(await screen.findByText(RESET_DONE_COPY)).toBeTruthy();
    expect(RESET_DONE_COPY).toBe("Password changed. Sign in with your new password.");
    expect(screen.getByRole("link", { name: /sign in/i }).getAttribute("href")).toBe("/sign-in");
    expect(f).toHaveBeenCalledWith("/api/reset-password", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ code: CODE, password: PW });
  });

  it("shows the invalid-code copy", async () => {
    fill(PW, PW, new Response(JSON.stringify({ error: "RESET_CODE_INVALID" }), { status: 400 }));
    expect(await screen.findByText(RESET_CODE_INVALID_COPY)).toBeTruthy();
  });

  it("shows the rate-limit wait", async () => {
    fill(PW, PW, new Response("{}", { status: 429, headers: { "Retry-After": "60" } }));
    expect(await screen.findByText("Too many attempts. Try again in 60 seconds.")).toBeTruthy();
  });
});
