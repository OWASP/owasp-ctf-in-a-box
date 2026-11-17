// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { $fetch, signInUsername, signInSocial } = vi.hoisted(() => ({
  $fetch: vi.fn(),
  signInUsername: vi.fn(),
  signInSocial: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { $fetch, signIn: { username: signInUsername, social: signInSocial } },
}));

import PasswordAuthForm from "@/components/password-auth-form";

const PW = "correct horse battery";

function setHref() {
  let href = "http://localhost/sign-in";
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

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function openCreate() {
  fireEvent.click(screen.getByRole("tab", { name: "Create an account" }));
}

beforeEach(() => {
  $fetch.mockResolvedValue({ data: {}, error: null });
  signInUsername.mockResolvedValue({ data: {}, error: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PasswordAuthForm tabs", () => {
  it("wires each tab to the panel and names the panel by the selected tab", () => {
    render(<PasswordAuthForm next="/flags" providers={["github"]} />);
    const panel = screen.getByRole("tabpanel");
    for (const tab of screen.getAllByRole("tab")) expect(tab.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(screen.getByRole("tab", { name: "Sign in" }).id);
    openCreate();
    expect(panel.getAttribute("aria-labelledby")).toBe(screen.getByRole("tab", { name: "Create an account" }).id);
  });
});

describe("PasswordAuthForm sign-in", () => {
  it("signs in and navigates through the post-signin step", async () => {
    const href = setHref();
    render(<PasswordAuthForm next="/flags" providers={["github"]} />);
    type("Username", "alice");
    type("Password", PW);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(href()).toBe("/api/post-signin?next=%2Fflags"));
    expect(signInUsername).toHaveBeenCalledWith({ username: "alice", password: PW });
  });

  it("says wrong username or password for bad credentials", async () => {
    signInUsername.mockResolvedValue({
      data: null,
      error: { status: 401, code: "INVALID_USERNAME_OR_PASSWORD" },
    });
    render(<PasswordAuthForm next="/profile" providers={["github"]} />);
    type("Username", "alice");
    type("Password", PW);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Wrong username or password.")).toBeTruthy();
  });

  it("reports the retry wait on a 429", async () => {
    signInUsername.mockResolvedValue({
      data: null,
      error: { status: 429, code: "RATE_LIMITED", retryAfterSeconds: 42 },
    });
    render(<PasswordAuthForm next="/profile" providers={["github"]} />);
    type("Username", "alice");
    type("Password", PW);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Too many attempts. Try again in 42 seconds.")).toBeTruthy();
  });

  it("says 1 second, not 1 seconds, when the wait rounds to one", async () => {
    signInUsername.mockResolvedValue({
      data: null,
      error: { status: 429, code: "RATE_LIMITED", retryAfterSeconds: 0.4 },
    });
    render(<PasswordAuthForm next="/profile" providers={["github"]} />);
    type("Username", "alice");
    type("Password", PW);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Too many attempts. Try again in 1 second.")).toBeTruthy();
  });

  it("falls back to the generic copy for anything else, including a thrown fetch", async () => {
    signInUsername.mockRejectedValue(new Error("network"));
    render(<PasswordAuthForm next="/profile" providers={["github"]} />);
    type("Username", "alice");
    type("Password", PW);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy();
  });

  it("labels the inputs with the right autocomplete hints and a polite error region", () => {
    const { container } = render(<PasswordAuthForm next="/profile" providers={["github"]} />);
    expect(screen.getByLabelText("Username").getAttribute("autocomplete")).toBe("username");
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("current-password");
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
});

describe("PasswordAuthForm sign-up", () => {
  it("posts only username and password, then navigates through the post-signin step", async () => {
    const href = setHref();
    render(<PasswordAuthForm next="/profile#team" providers={[]} />);
    openCreate();
    type("Username", "alice");
    type("Password", PW);
    type("Confirm password", PW);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect($fetch).toHaveBeenCalledTimes(1));
    expect($fetch).toHaveBeenCalledWith("/sign-up/email", {
      method: "POST",
      body: { username: "alice", password: PW },
    });
    const body = $fetch.mock.calls[0][1].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["password", "username"]);
    await waitFor(() => expect(href()).toBe("/api/post-signin?next=%2Fprofile%23team"));
  });

  it("uses new-password autocomplete on both password fields", () => {
    render(<PasswordAuthForm next="/profile" providers={["github"]} />);
    openCreate();
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByLabelText("Confirm password").getAttribute("autocomplete")).toBe("new-password");
  });

  it("never calls the API when the passwords differ", () => {
    render(<PasswordAuthForm next="/profile" providers={["github"]} />);
    openCreate();
    type("Username", "alice");
    type("Password", PW);
    type("Confirm password", PW + "x");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByText("The passwords don't match.")).toBeTruthy();
    expect($fetch).not.toHaveBeenCalled();
  });

  it.each([11, 129])("refuses a %i-character password locally, making no request", (n) => {
    render(<PasswordAuthForm next="/profile" providers={["github"]} />);
    openCreate();
    type("Username", "alice");
    type("Password", "p".repeat(n));
    type("Confirm password", "p".repeat(n));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByText("Passwords are 12 to 128 characters.")).toBeTruthy();
    expect($fetch).not.toHaveBeenCalled();
  });

  it.each([12, 128])("posts a %i-character password", async (n) => {
    render(<PasswordAuthForm next="/profile" providers={["github"]} />);
    openCreate();
    type("Username", "alice");
    type("Password", "p".repeat(n));
    type("Confirm password", "p".repeat(n));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect($fetch).toHaveBeenCalledTimes(1));
  });

  it("checks the username locally before posting", () => {
    render(<PasswordAuthForm next="/profile" providers={["github"]} />);
    openCreate();
    type("Username", "a b");
    type("Password", PW);
    type("Confirm password", PW);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByText("Usernames are 3 to 30 letters, digits, dots or underscores.")).toBeTruthy();
    expect($fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["USERNAME_IS_ALREADY_TAKEN", "That username is taken."],
    ["USER_ALREADY_EXISTS", "That username is taken."],
    ["USERNAME_TOO_SHORT", "Usernames are 3 to 30 letters, digits, dots or underscores."],
    ["USERNAME_TOO_LONG", "Usernames are 3 to 30 letters, digits, dots or underscores."],
    ["INVALID_USERNAME", "Usernames are 3 to 30 letters, digits, dots or underscores."],
    ["PASSWORD_TOO_SHORT", "Passwords are 12 to 128 characters."],
    ["PASSWORD_TOO_LONG", "Passwords are 12 to 128 characters."],
    ["SOMETHING_ELSE", "Something went wrong. Try again."],
  ])("renders the exact copy for %s", async (code, copy) => {
    $fetch.mockResolvedValue({ data: null, error: { status: 400, code } });
    render(<PasswordAuthForm next="/profile" providers={["github"]} />);
    openCreate();
    type("Username", "alice");
    type("Password", PW);
    type("Confirm password", PW);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText(copy)).toBeTruthy();
  });

  it("reports the retry wait on a 429", async () => {
    $fetch.mockResolvedValue({
      data: null,
      error: { status: 429, code: "RATE_LIMITED", retryAfterSeconds: 7 },
    });
    render(<PasswordAuthForm next="/profile" providers={["github"]} />);
    openCreate();
    type("Username", "alice");
    type("Password", PW);
    type("Confirm password", PW);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Too many attempts. Try again in 7 seconds.")).toBeTruthy();
  });
});

describe("PasswordAuthForm GitHub", () => {
  it("shows the retry wait when GitHub sign-in is rate limited", async () => {
    signInSocial.mockResolvedValue({ error: { status: 429, code: "RATE_LIMITED", retryAfterSeconds: 30 } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<PasswordAuthForm next="/profile" providers={["github"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
    expect(await screen.findByText("Too many attempts. Try again in 30 seconds.")).toBeTruthy();
  });

  it("starts GitHub with the post-signin and error callbacks", () => {
    signInSocial.mockResolvedValue({});
    render(<PasswordAuthForm next="/flags" providers={["github"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
    expect(signInSocial).toHaveBeenCalledWith({
      provider: "github",
      callbackURL: "/api/post-signin?next=%2Fflags",
      errorCallbackURL: "/?next=%2Fflags",
    });
  });
});

describe("PasswordAuthForm providers", () => {
  it("renders no provider button or divider when none are enabled", () => {
    const { container } = render(<PasswordAuthForm next="/profile" providers={[]} />);
    expect(screen.queryAllByRole("button", { name: /Sign in with/ })).toHaveLength(0);
    expect(container.querySelector("[data-provider-divider]")).toBeNull();
  });

  it("renders one button per enabled provider, in order, with the terminal label", () => {
    render(<PasswordAuthForm next="/profile" providers={["google", "discord"]} />);
    const names = screen.getAllByRole("button", { name: /Sign in with/ }).map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Sign in with Google", "Sign in with Discord"]);
    expect(screen.getByText(/sign-in --google/)).toBeTruthy();
    expect(screen.getByText(/sign-in --discord/)).toBeTruthy();
  });

  it("starts the clicked provider", () => {
    signInSocial.mockResolvedValue({});
    render(<PasswordAuthForm next="/flags" providers={["google", "discord"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    expect(signInSocial).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/api/post-signin?next=%2Fflags",
      errorCallbackURL: "/?next=%2Fflags",
    });
  });

  it("shows copy for a PROVIDER_DISABLED refusal", async () => {
    signInSocial.mockResolvedValue({ error: { status: 403, code: "PROVIDER_DISABLED" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<PasswordAuthForm next="/profile" providers={["google"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    expect(await screen.findByText("That sign-in option is not available.")).toBeTruthy();
  });

  it("shows copy when the sign-in settings cannot be read", async () => {
    signInSocial.mockResolvedValue({ error: { status: 503, code: "SIGN_IN_SETTINGS_UNREADABLE" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<PasswordAuthForm next="/profile" providers={["google"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    expect(await screen.findByText("Sign-in options could not be loaded. Try again.")).toBeTruthy();
  });
});
