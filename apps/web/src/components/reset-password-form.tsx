"use client";

// The /reset form: a reset code from an organizer plus a new password, used
// signed out. Success signs nobody in; it points at /sign-in.

import Link from "next/link";
import { useState } from "react";
import { GENERIC_COPY, MISMATCH_COPY, PASSWORD_COPY, rateLimitCopy } from "@/components/password-auth-form";
import { RESET_CODE_INVALID_COPY, RESET_DONE_COPY, RESET_UNAVAILABLE_COPY } from "@/lib/password-reset-copy";

const INPUT =
  "w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-sm text-white placeholder:text-zinc-600 focus-visible:border-[#2563eb]/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";
const SUBMIT =
  "rounded-md bg-[#2563eb] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1d4ed8] disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";

export default function ResetPasswordForm() {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    // The server's bounds, checked here so a short password costs no attempt.
    if (password.length < 12 || password.length > 128) return setError(PASSWORD_COPY);
    if (password !== confirm) return setError(MISMATCH_COPY);
    setPending(true);
    try {
      const res = await fetch("/api/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), password }),
      });
      if (res.ok) return setDone(true);
      if (res.status === 429) return setError(rateLimitCopy(Number(res.headers.get("Retry-After"))));
      if (res.status === 503) return setError(RESET_UNAVAILABLE_COPY);
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (body?.error === "RESET_CODE_INVALID") return setError(RESET_CODE_INVALID_COPY);
      if (body?.error === "PASSWORD_LENGTH") return setError(PASSWORD_COPY);
      setError(GENERIC_COPY);
    } catch {
      setError(GENERIC_COPY);
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div role="status" className="flex max-w-sm flex-col gap-3 text-sm text-zinc-300">
        <p>{RESET_DONE_COPY}</p>
        <Link href="/sign-in" className="self-start font-mono text-[#60a5fa] underline-offset-4 hover:underline">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex max-w-sm flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm text-zinc-300">
        Reset code
        <input
          type="text"
          name="code"
          autoComplete="one-time-code"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className={INPUT}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm text-zinc-300">
        New password
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
        Reset password
      </button>
    </form>
  );
}
