// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/auth-client", () => ({ authClient: {} }));

import AddPasswordForm from "@/components/add-password-form";

const PW = "correct horse battery";

function submitWith429(retryAfter: string | null) {
  const headers = new Headers();
  if (retryAfter !== null) headers.set("Retry-After", retryAfter);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 429, headers })));
  render(<AddPasswordForm />);
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: PW } });
  fireEvent.change(screen.getByLabelText(/confirm/i), { target: { value: PW } });
  fireEvent.click(screen.getByRole("button", { name: /password/i }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AddPasswordForm rate limit copy", () => {
  it("is singular at exactly one second", async () => {
    submitWith429("1");
    expect(await screen.findByText("Too many attempts. Try again in 1 second.")).toBeTruthy();
  });

  it("is plural above one second and rounds up", async () => {
    submitWith429("2.2");
    await waitFor(() => expect(screen.getByText("Too many attempts. Try again in 3 seconds.")).toBeTruthy());
  });

  it("falls back when there is no Retry-After", async () => {
    submitWith429(null);
    expect(await screen.findByText("Too many attempts. Try again shortly.")).toBeTruthy();
  });
});
