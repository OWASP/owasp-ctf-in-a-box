"use client";

// The classic and ai challenge pages' paid-hint control (#190, issue #211):
// one button that charges and reveals through the SAME /api/hints/reveal
// endpoint the secure-development rows use — the server is the boundary that
// gates, charges idempotently, and never sends a text that wasn't paid for.
// Already-owned hints never reach this component: the page renders their
// text server-side and this button only exists while there is something to
// buy. `app` is the target this reveal is charged against (Task 1's
// `HintTarget`) — originally hardcoded to "classic", now the caller's prop so
// flags/[id] and ai/[id] share one component instead of a copy each.
//
// A reveal is a PAID, irreversible deduction, so the first press does not
// charge: it opens a confirm step (idle → confirm → pending), mirroring the
// in-row `hint-button.tsx` chip, and only the confirm button fires the request
// (#550). Once revealed, the block acknowledges the −cost so the contestant is
// not left to discover the deduction silently on the leaderboard later.
//
// NOT the secure-development row control: that one lives in hint-button.tsx
// (a compact confirm-then-reveal chip embedded in a 110-row list, driven by
// `onPurchased` so the parent can update its own purchased map). This is the
// single challenge page's own control — the revealed text renders in place of
// the button.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { HintTarget } from "@/lib/hint-store";

export default function HintRevealButton({ app, id, cost }: { app: HintTarget; id: string; cost: number }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "confirm" | "pending">("idle");
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  // The points actually deducted by THIS reveal, or null when it charged
  // nothing (an admin preview, or an already-owned reveal). Only a real charge
  // gets the "−N pts spent" acknowledgement, and it uses the server's figure.
  const [chargedCost, setChargedCost] = useState<number | null>(null);
  // The contestant's net score after this reveal, from the server (#553) —
  // shown only beside a real deduction; a preview or re-view moved nothing.
  const [balance, setBalance] = useState<number | null>(null);
  const revealedRef = useRef<HTMLParagraphElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const idleRef = useRef<HTMLButtonElement>(null);
  // Tracks the state we are leaving, so a return to "idle" can be told apart
  // from the first mount: only a return (prev was confirm/pending) moves focus.
  const prevState = useRef(state);

  // The revealed hint REPLACES the button that was just pressed, and the HTML
  // focus fixup rule does not hand focus to a replacement — it drops it on
  // <body>. So a keyboard user paid points for a hint and lost their place in
  // the page, and the next Tab restarted from the top of the document.
  // Announcing the text (role="status", below) fixes what is heard; this fixes
  // where the user IS. tabIndex={-1} makes the paragraph a programmatic focus
  // target without adding it to the tab order. The same replaced-while-focused
  // problem applies in both directions: the idle button swaps for the confirm
  // pair (focus the confirm button), and Cancel or a failed reveal swaps the
  // confirm pair back for the idle button (focus the idle button). Neither is
  // run on first mount — `prevState` guards the return so initial render does
  // not steal focus.
  useEffect(() => {
    const returning = prevState.current === "confirm" || prevState.current === "pending";
    prevState.current = state;
    if (text) revealedRef.current?.focus();
    else if (state === "confirm") confirmRef.current?.focus();
    else if (state === "idle" && returning) idleRef.current?.focus();
  }, [text, state]);

  async function reveal() {
    if (state === "pending") return;
    setState("pending");
    setError(null);
    try {
      const res = await fetch("/api/hints/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app, id }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        hint?: string;
        error?: string;
        cost?: number;
        balance?: number;
        alreadyOwned?: boolean;
        dryRun?: boolean;
      };
      if (res.ok && typeof data.hint === "string") {
        // A preview (dryRun) and an already-owned reveal both return the hint
        // but deduct nothing — only a real charge is acknowledged, with the
        // server's authoritative cost rather than the render-time prop (the
        // organizer may have changed the price since this page loaded).
        // Only a positive deduction is acknowledged: a preview (dryRun) and an
        // already-owned reveal charge nothing, and a configured cost of 0
        // deducts nothing either — none of those should render "−0 pts spent".
        const deducted =
          !data.dryRun && !data.alreadyOwned ? (typeof data.cost === "number" ? data.cost : cost) : 0;
        setChargedCost(deducted > 0 ? deducted : null);
        setBalance(deducted > 0 && typeof data.balance === "number" ? data.balance : null);
        setText(data.hint);
        // Resync the page's server state (spent total, owned set) — the
        // revealed text itself stays in local state so it shows instantly.
        router.refresh();
      } else {
        // A failed reveal charges nothing; drop back to idle so the contestant
        // can retry, with the reason shown below the button.
        setError(data.error === "not-launched" ? "The event hasn't launched yet." : typeof data.error === "string" ? data.error : "Couldn't reveal the hint. Try again.");
        setState("idle");
      }
    } catch {
      setError("Couldn't reveal the hint. Try again.");
      setState("idle");
    }
  }

  // Announced, because this text REPLACES the button that was focused: without
  // a live region the click consumed points and produced silence for a
  // screen-reader user, with focus dropped to the document body. The spent
  // acknowledgement rides in the same region so the deduction is heard too.
  if (text) {
    return (
      <p
        ref={revealedRef}
        tabIndex={-1}
        role="status"
        className="rounded border-l-2 border-[#d4a017]/50 bg-[#d4a017]/[0.06] px-3 py-2 text-sm leading-relaxed text-[#d4a017]/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
      >
        <span aria-hidden="true">💡</span> <span className="sr-only">Hint: </span>
        {text}
        {chargedCost !== null && (
          <span className="mt-1 block text-xs text-[#d4a017]/70">
            −{chargedCost} pts spent{balance !== null && <> · your score is now {balance}</>}
          </span>
        )}
      </p>
    );
  }

  if (state === "confirm" || state === "pending") {
    return (
      <div className="flex flex-col gap-1">
        <span className="sr-only" role="status">
          {state === "pending" ? "Revealing hint…" : `Confirm: spend ${cost} points on this hint.`}
        </span>
        <div className="flex items-center gap-2">
          <button
            ref={confirmRef}
            type="button"
            onClick={reveal}
            disabled={state === "pending"}
            className="w-fit rounded-md border border-[#d4a017]/60 px-3 py-1.5 text-sm text-[#d4a017] transition-colors hover:bg-[#d4a017]/10 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
          >
            {state === "pending" ? (
              "Revealing…"
            ) : (
              <>
                <span aria-hidden="true">💡</span> Confirm (−{cost} pts)
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setState("idle")}
            disabled={state === "pending"}
            className="w-fit rounded-md border border-white/10 px-3 py-1.5 text-sm text-muted transition-colors hover:text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        ref={idleRef}
        type="button"
        onClick={() => setState("confirm")}
        className="w-fit rounded-md border border-[#d4a017]/40 px-3 py-1.5 text-sm text-[#d4a017] transition-colors hover:bg-[#d4a017]/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
      >
        <span aria-hidden="true">💡</span> Reveal hint (−{cost} pts)
      </button>
      {error && (
        <p role="alert" className="text-xs text-[#e53e3e]">
          {error}
        </p>
      )}
    </div>
  );
}
