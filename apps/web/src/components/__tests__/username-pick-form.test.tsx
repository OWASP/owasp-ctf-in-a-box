// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import UsernamePickForm from "@/components/username-pick-form";

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function setHref() {
  let href = "http://localhost/welcome";
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() {
        return href;
      },
      set href(v: string) {
        href = v;
      },
    },
  });
  return () => href;
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function pick(name: string) {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

const live = (container: HTMLElement) => container.querySelector('[aria-live="polite"]')!.textContent;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(reply(200, { ok: true }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("UsernamePickForm", () => {
  it("refuses a malformed name locally, making no request", () => {
    const { container } = render(<UsernamePickForm next="/profile" />);
    pick("a b");
    expect(live(container)).toBe("Usernames are 3 to 30 letters, digits, dots or underscores.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the trimmed name and navigates through the post-signin step on 2xx", async () => {
    const href = setHref();
    render(<UsernamePickForm next="/profile#team" />);
    pick("  Alice ");
    await waitFor(() => expect(href()).toBe("/api/post-signin?next=%2Fprofile%23team"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/me/username");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ username: "Alice" });
  });

  it("navigates on already_set: another tab picked one", async () => {
    const href = setHref();
    fetchMock.mockResolvedValue(reply(409, { error: "already_set" }));
    render(<UsernamePickForm next="/flags" />);
    pick("alice");
    await waitFor(() => expect(href()).toBe("/api/post-signin?next=%2Fflags"));
  });

  it.each([
    [429, { error: "rate-limited" }, "Too many attempts. Try again shortly."],
    [409, { error: "taken" }, "That username is taken."],
    [400, { error: "invalid" }, "Usernames are 3 to 30 letters, digits, dots or underscores."],
    [500, { error: "unavailable" }, "Something went wrong. Try again."],
  ])("shows the copy for a %i %j, staying on the page", async (status, body, copy) => {
    const href = setHref();
    fetchMock.mockResolvedValue(reply(status, body));
    const { container } = render(<UsernamePickForm next="/profile" />);
    pick("alice");
    await waitFor(() => expect(live(container)).toBe(copy));
    expect(href()).toBe("http://localhost/welcome");
  });

  it("shows the generic copy when the request throws", async () => {
    fetchMock.mockRejectedValue(new TypeError("network"));
    const { container } = render(<UsernamePickForm next="/profile" />);
    pick("alice");
    await waitFor(() => expect(live(container)).toBe("Something went wrong. Try again."));
  });
});
