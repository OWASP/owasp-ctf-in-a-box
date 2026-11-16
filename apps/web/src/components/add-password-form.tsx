"use client";

// The profile's "Add a password" card, shown only to an account that has none
// (a GitHub sign-in). Success reloads the page, which then hides the card.

import { useState } from "react";
import { GENERIC_COPY, MISMATCH_COPY, PASSWORD_COPY } from "@/components/password-auth-form";

const INPUT =
  "w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-sm text-white placeholder:text-zinc-600 focus-visible:border-[#2563eb]/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";
const SUBMIT =
  "rounded-md bg-[#2563eb] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1d4ed8] disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";

export default function AddPasswordForm() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    if (password.length < 12 || password.length > 128) return setError(PASSWORD_COPY);
    if (password !== confirm) return setError(MISMATCH_COPY);
    setPending(true);
    try {
      const res = await fetch("/api/me/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: password }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      // already_set: another tab added one, so the card is stale either way.
      if (res.ok || body?.error === "already_set") {
        window.location.reload();
        return;
      }
      if (res.status === 429) {
        const n = Number(res.headers.get("Retry-After"));
        return setError(
          Number.isFinite(n) && n > 0
            ? `Too many attempts. Try again in ${Math.ceil(n)} seconds.`
            : "Too many attempts. Try again shortly.",
        );
      }
      if (body?.error === "length") return setError(PASSWORD_COPY);
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
        Password
        <input
          type="password"
          name="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={INPUT}
        />
      </label>
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
      <p className="text-xs text-muted">{PASSWORD_COPY}</p>
      <div aria-live="polite" className="min-h-5 text-sm text-[#e53e3e]">
        {error}
      </div>
      <button type="submit" disabled={pending} className={`${SUBMIT} self-start`}>
        Add password
      </button>
    </form>
  );
}
