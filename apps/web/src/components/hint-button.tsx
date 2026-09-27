"use client";

// Compact in-row hint control for one challenge. Owns the purchase flow
// (idle → confirm → pending → error); the revealed text itself is rendered by
// the parent list from its purchased map, so a hint bought here and a hint
// loaded from GET /api/hints display identically. Signed-out visitors get a
// disabled lock teaser — the actual gate is the authenticated API route.

import { useEffect, useRef, useState } from "react";
import type { AppId } from "@/lib/apps";

// ds-tap-24 grows the pointer target to the WCAG 2.5.8 minimum without
// changing the chip's visual box — the rows stack up to 110 deep, so the
// visible size has to stay small. See globals.css.
const CHIP =
  "ds-tap-24 flex-none rounded border px-1 text-[10px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";

export default function HintButton({
  app,
  id,
  cost,
  signedIn,
  onPurchased,
}: {
  app: AppId;
  id: string;
  cost: number;
  signedIn: boolean;
  /** Called with the hint text and the viewer's new penalty total. */
  onPurchased: (app: AppId, id: string, text: string, spent: number) => void;
}) {
  const [state, setState] = useState<"idle" | "confirm" | "pending" | "error">("idle");
  const [error, setError] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  // Pressing the chip swaps it for the confirm/cancel pair, which unmounts the
  // button that was focused. The browser does not move focus to a replacement
  // — the focus fixup rule drops it on <body> — so a keyboard user pressed
  // "reveal", got a confirmation they were no longer anywhere near, and had to
  // Tab from the top of a page that runs to 110 challenge rows. Focus the
  // control that is now the point of the interaction.
  //
  // The same applies to the transition OUT of "confirm": a failed reveal
  // unmounts the confirm/cancel pair and mounts the retry chip in its place,
  // which is another replaced-while-focused element and another trip to
  // <body>. (The success path leaves this component entirely — the parent
  // swaps it for the revealed hint — and is handled where that swap happens,
  // in challenge-grid.tsx.)
  //
  // Not run for "pending": that state re-renders the SAME button rather than
  // mounting a new one, so focus is already where it belongs and re-focusing
  // would fight a user who tabbed to Cancel mid-flight. Not run for "idle"
  // either — reaching it means the user pressed Cancel, and the browser keeps
  // focus sensibly there; forcing it would also steal focus on first mount.
  useEffect(() => {
    if (state === "confirm") confirmRef.current?.focus();
    if (state === "error") chipRef.current?.focus();
  }, [state]);

  if (!signedIn) {
    return (
      <button
        type="button"
        disabled
        title={`Sign in with GitHub to unlock hints (−${cost} pts each)`}
        aria-label="Sign in with GitHub to unlock hints"
        className={`${CHIP} cursor-not-allowed border-white/10 text-zinc-600`}
      >
        🔒
      </button>
    );
  }

  async function reveal() {
    setState("pending");
    try {
      const res = await fetch("/api/hints/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app, id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.hint !== "string") {
        throw new Error(data.error === "not-launched" ? "The event hasn't launched yet." : typeof data.error === "string" ? data.error : "Hint reveal failed. Try again");
      }
      onPurchased(app, id, data.hint, Number(data.spent) || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Hint reveal failed. Try again");
      setState("error");
    }
  }

  if (state === "confirm" || state === "pending") {
    return (
      <span className="flex flex-none items-center gap-1">
        <span className="sr-only" role="status">
          {state === "pending" ? "Revealing hint…" : `Confirm: spend ${cost} points on this hint.`}
        </span>
        <button
          ref={confirmRef}
          type="button"
          onClick={reveal}
          disabled={state === "pending"}
          className={`${CHIP} border-[#d4a017]/60 text-[#d4a017] hover:bg-[#d4a017]/10 disabled:opacity-50`}
        >
          <span aria-hidden="true">{state === "pending" ? "…" : `−${cost} pts ✓`}</span>
          <span className="sr-only">
            {state === "pending" ? "Revealing" : `Confirm, spend ${cost} points`}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setState("idle")}
          disabled={state === "pending"}
          aria-label="Cancel"
          className={`${CHIP} border-white/10 text-muted hover:text-white disabled:opacity-50`}
        >
          ✕
        </button>
      </span>
    );
  }

  return (
    <button
      ref={chipRef}
      type="button"
      onClick={() => setState("confirm")}
      title={state === "error" ? `${error} (click to retry)` : `Reveal hint for ${cost} points`}
      aria-label={
        state === "error"
          ? `${error}. Retry revealing this hint for ${cost} points`
          : `Reveal hint for ${cost} points`
      }
      className={`${CHIP} ${
        state === "error"
          ? "border-[#e53e3e]/60 text-[#e53e3e] hover:bg-[#e53e3e]/10"
          : "border-white/10 text-muted hover:border-[#d4a017]/60 hover:text-[#d4a017]"
      }`}
    >
      <span aria-hidden="true">{state === "error" ? "⚠ retry" : `💡 −${cost}`}</span>
      {/* The failure is also announced once, politely: the chip's own name
          only reaches a screen reader if the user happens to be on it. */}
      {state === "error" && (
        <span className="sr-only" role="status">
          {error}
        </span>
      )}
    </button>
  );
}
