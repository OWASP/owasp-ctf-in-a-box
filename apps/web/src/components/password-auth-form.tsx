"use client";

// The sign-in page's form: username + password sign-in, username + password
// account creation, and one button per enabled OAuth provider. Success navigates (full load) to
// the post-signin step, so a password sign-in meets the same team steering as
// an OAuth one.

import { PROVIDER_DISABLED_COPY, SIGN_IN_SETTINGS_UNREADABLE_COPY } from "@/lib/sign-in-error-copy";
import Link from "next/link";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { oauthErrorCallbackURL, postSigninCallbackURL } from "@/lib/post-signin";
import { PROVIDER_LABEL, type SignInProviderId } from "@/lib/sign-in-providers";
import { usernameProblem } from "@/lib/username-rules";

const USERNAME_COPY = "Usernames are 3 to 30 letters, digits, dots or underscores.";
export const PASSWORD_COPY = "Passwords are 12 to 128 characters.";
export const GENERIC_COPY = "Something went wrong. Try again.";

export const MISMATCH_COPY = "The passwords don't match.";

/** The rate-limit message for a Retry-After of `n` seconds: the wait is
 *  rounded up to a whole second and singular at exactly 1. */
export function rateLimitCopy(n: number | null | undefined): string {
  const wait = typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
  return wait !== null
    ? `Too many attempts. Try again in ${wait} ${wait === 1 ? "second" : "seconds"}.`
    : "Too many attempts. Try again shortly.";
}

type AuthError = { status?: number; code?: string; retryAfterSeconds?: number } | null | undefined;

/** Contestant-facing copy for a better-auth error. The code strings are the
 *  ones better-auth and the username plugin define, plus RATE_LIMITED from
 *  lib/auth-rate-limit.ts. */
function errorCopy(error: AuthError): string {
  if (!error) return GENERIC_COPY;
  if (error.status === 429 || error.code === "RATE_LIMITED") {
    return rateLimitCopy(error.retryAfterSeconds);
  }
  switch (error.code) {
    case "USERNAME_IS_ALREADY_TAKEN":
    case "USER_ALREADY_EXISTS":
      return "That username is taken.";
    case "USERNAME_TOO_SHORT":
    case "USERNAME_TOO_LONG":
    case "INVALID_USERNAME":
      return USERNAME_COPY;
    case "PASSWORD_TOO_SHORT":
    case "PASSWORD_TOO_LONG":
      return PASSWORD_COPY;
    case "INVALID_USERNAME_OR_PASSWORD":
      return "Wrong username or password.";
    case "PROVIDER_DISABLED":
      return PROVIDER_DISABLED_COPY;
    case "SIGN_IN_SETTINGS_UNREADABLE":
      return SIGN_IN_SETTINGS_UNREADABLE_COPY;
    default:
      return GENERIC_COPY;
  }
}

const INPUT =
  "w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-sm text-white placeholder:text-zinc-600 focus-visible:border-[#2563eb]/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";
const SUBMIT =
  "rounded-md bg-[#2563eb] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1d4ed8] disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";

export default function PasswordAuthForm({ next, providers }: { next: string; providers: readonly SignInProviderId[] }) {
  const [mode, setMode] = useState<"sign-in" | "create">("sign-in");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const creating = mode === "create";

  function switchMode(m: "sign-in" | "create") {
    setMode(m);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    if (creating) {
      if (usernameProblem(username)) return setError(USERNAME_COPY);
      // The server's bounds (emailAndPassword in lib/auth.ts), checked here
      // so a short password costs no request and no sign-up budget.
      if (password.length < 12 || password.length > 128) return setError(PASSWORD_COPY);
      if (password !== confirm) return setError(MISMATCH_COPY);
    }
    setPending(true);
    try {
      const name = username.trim();
      // Exactly { username, password }: the server refuses any other field
      // and fills in the email and display name itself.
      const res = creating
        ? await authClient.$fetch("/sign-up/email", { method: "POST", body: { username: name, password } })
        : await authClient.signIn.username({ username: name, password });
      if (res.error) {
        setError(errorCopy(res.error as AuthError));
        return;
      }
      window.location.href = postSigninCallbackURL(next);
    } catch {
      setError(GENERIC_COPY);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex max-w-sm flex-col gap-6">
      <div role="tablist" aria-label="Sign in or create an account" className="flex gap-2 font-mono text-sm">
        {(["sign-in", "create"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            id={`auth-tab-${m}`}
            aria-controls="auth-panel"
            aria-selected={mode === m}
            onClick={() => switchMode(m)}
            className={`rounded-md border px-3 py-1.5 transition-colors ${
              mode === m
                ? "border-[#2563eb]/60 bg-white/[0.06] text-white"
                : "border-white/10 text-zinc-400 hover:text-white"
            }`}
          >
            {m === "sign-in" ? "Sign in" : "Create an account"}
          </button>
        ))}
      </div>

      <form
        onSubmit={submit}
        noValidate
        role="tabpanel"
        id="auth-panel"
        aria-labelledby={`auth-tab-${mode}`}
        className="flex flex-col gap-4"
      >
        <label className="flex flex-col gap-1.5 text-sm text-zinc-300">
          Username
          <input
            type="text"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={INPUT}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-zinc-300">
          Password
          <input
            type="password"
            name="password"
            autoComplete={creating ? "new-password" : "current-password"}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={INPUT}
          />
        </label>
        {creating && (
          <label className="flex flex-col gap-1.5 text-sm text-zinc-300">
            Confirm password
            <input
              type="password"
              name="confirm"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={INPUT}
            />
          </label>
        )}
        {creating && <p className="text-xs text-muted">{USERNAME_COPY} {PASSWORD_COPY}</p>}
        <div aria-live="polite" className="min-h-5 text-sm text-[#e53e3e]">
          {error}
        </div>
        <button type="submit" disabled={pending} className={`${SUBMIT} self-start`}>
          {creating ? "Create account" : "Sign in"}
        </button>
        <Link href="/reset" className="self-start text-xs text-zinc-400 underline-offset-4 hover:text-white hover:underline">
          Have a reset code from an organizer?
        </Link>
      </form>

      {providers.length > 0 && (
        <div data-provider-divider className="flex flex-col gap-2 border-t border-white/10 pt-4">
          {providers.map((provider) => (
            <button
              key={provider}
              type="button"
              aria-label={`Sign in with ${PROVIDER_LABEL[provider]}`}
              onClick={() => {
                setError(null);
                // errorCallbackURL points a failed callback at the landing
                // page's banner, carrying `next` so the retry keeps the
                // destination.
                void authClient.signIn
                  .social({
                    provider,
                    callbackURL: postSigninCallbackURL(next),
                    errorCallbackURL: oauthErrorCallbackURL(next),
                  })
                  .then((result) => {
                    if (result?.error) {
                      console.error("sign-in failed to start:", result.error);
                      setError(errorCopy(result.error));
                    }
                  })
                  .catch((err) => {
                    console.error("sign-in failed to start:", err);
                    setError(GENERIC_COPY);
                  });
              }}
              className="self-start rounded-md border border-white/10 bg-white/[0.03] px-4 py-2 font-mono text-sm text-zinc-200 transition-colors hover:border-[#2563eb]/45 hover:text-white"
            >
              <span className="text-[#22c55e]">$</span> sign-in --{provider}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
