"use client";

// The /welcome form: a first OAuth sign-in picks the name the board and the
// roster show. Success navigates (full load) through the post-signin step so
// the team steering runs with the refreshed session.

import { useState } from "react";
import { postSigninCallbackURL } from "@/lib/post-signin";
import { USERNAME_COPY, usernameProblem } from "@/lib/username-rules";

const GENERIC_COPY = "Something went wrong. Try again.";

const INPUT =
  "w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-sm text-white placeholder:text-zinc-600 focus-visible:border-[#2563eb]/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";
const SUBMIT =
  "rounded-md bg-[#2563eb] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1d4ed8] disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";

/** `next` is already sanitized by the page. */
export default function UsernamePickForm({ next }: { next: string }) {
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    if (usernameProblem(username)) return setError(USERNAME_COPY);
    setPending(true);
    try {
      const res = await fetch("/api/me/username", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim() }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      // already_set: another tab picked one, so there is nothing left to ask.
      if (res.ok || body?.error === "already_set") {
        window.location.href = postSigninCallbackURL(next);
        return;
      }
      if (res.status === 429) return setError("Too many attempts. Try again shortly.");
      if (body?.error === "taken") return setError("That username is taken.");
      if (body?.error === "invalid") return setError(USERNAME_COPY);
      setError(GENERIC_COPY);
    } catch {
      setError(GENERIC_COPY);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex max-w-sm flex-col gap-4">
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
      <p className="text-xs text-muted">{USERNAME_COPY}</p>
      <div aria-live="polite" className="min-h-5 text-sm text-[#e53e3e]">
        {error}
      </div>
      <button type="submit" disabled={pending} className={`${SUBMIT} self-start`}>
        Continue
      </button>
    </form>
  );
}
