"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

/** Where the player lands after the GitHub round-trip. The `linked=github`
 *  marker lets the profile tell a finished link from one better-auth
 *  reported done without the kit's record being written. */
export const DEFAULT_LINK_CALLBACK = "/profile?linked=github";

/** Starts better-auth's account link for the signed-in player. GitHub is
 *  used for identity only, so no `scopes` are requested. The error leg
 *  returns to the same page so the failure code is read where the player
 *  already is. */
export default function LinkGithubButton({ callbackURL = DEFAULT_LINK_CALLBACK }: { callbackURL?: string }) {
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);

  async function start() {
    setFailed(false);
    setPending(true);
    try {
      const res = await authClient.linkSocial({ provider: "github", callbackURL, errorCallbackURL: callbackURL });
      if (res?.error) {
        setFailed(true);
        setPending(false);
      }
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => void start()}
        className="rounded-md border border-[#14b8a6]/50 bg-[#14b8a6]/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#14b8a6]/20 disabled:opacity-60"
      >
        Link GitHub account
      </button>
      {failed && (
        <p role="alert" className="text-sm text-[#d4a017]">
          Linking GitHub didn&apos;t finish. Try again.
        </p>
      )}
    </div>
  );
}
