"use client";

// The claim form: one field, POST to /api/me/admin/claim, then into /admin.
// The code is never kept anywhere but this field's state.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CLAIM_INVALID } from "@/lib/admin-claim-copy";

/** What the form says for each non-200 answer. Only the 400 carries copy from
 *  the server, and that copy is the one fixed refusal. */
export function claimErrorText(status: number, retryAfter: string | null): string {
  if (status === 400) return CLAIM_INVALID;
  if (status === 401) return "Your session ended. Sign in again, then retry.";
  if (status === 409) return "You are already an organizer.";
  if (status === 429) {
    const minutes = Math.max(1, Math.ceil(Number(retryAfter ?? "60") / 60));
    return `Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  return "Could not check the code right now. Try again in a moment.";
}

export default function ClaimForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/me/admin/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok || res.status === 409) {
        setCode("");
        router.push("/admin");
        return;
      }
      setError(claimErrorText(res.status, res.headers.get("Retry-After")));
    } catch {
      setError(claimErrorText(0, null));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label htmlFor="admin-claim-code" className="text-sm font-medium text-zinc-200">
        Admin claim code
      </label>
      <input
        id="admin-claim-code"
        name="code"
        type="text"
        required
        autoComplete="off"
        spellCheck={false}
        inputMode="text"
        placeholder="xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-[#2563eb]/60 focus:outline-none"
      />
      <div>
        <button
          type="submit"
          disabled={pending || code.trim() === ""}
          className="rounded-md border border-white/10 bg-white/[0.03] px-4 py-2 font-mono text-sm text-zinc-200 transition-colors hover:border-[#2563eb]/45 hover:text-white disabled:opacity-50"
        >
          {pending ? "Checking…" : "Claim admin"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-[#e53e3e]">
          {error}
        </p>
      )}
    </form>
  );
}
