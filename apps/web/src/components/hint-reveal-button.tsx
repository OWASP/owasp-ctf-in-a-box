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
// NOT the secure-development row control: that one lives in hint-button.tsx
// (a compact confirm-then-reveal chip embedded in a 110-row list, driven by
// `onPurchased` so the parent can update its own purchased map). This is the
// single challenge page's own control — reveal happens on click, no separate
// confirm step, and the revealed text renders in place of the button.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { HintTarget } from "@/lib/hint-store";

export default function HintRevealButton({ app, id, cost }: { app: HintTarget; id: string; cost: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const revealedRef = useRef<HTMLParagraphElement>(null);

  // The revealed hint REPLACES the button that was just pressed, and the HTML
  // focus fixup rule does not hand focus to a replacement — it drops it on
  // <body>. So a keyboard user paid points for a hint and lost their place in
  // the page, and the next Tab restarted from the top of the document.
  // Announcing the text (role="status", below) fixes what is heard; this fixes
  // where the user IS. tabIndex={-1} makes the paragraph a programmatic focus
  // target without adding it to the tab order.
  useEffect(() => {
    if (text) revealedRef.current?.focus();
  }, [text]);

  async function reveal() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/hints/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app, id }),
      });
      const data = (await res.json().catch(() => ({}))) as { hint?: string; error?: string };
      if (res.ok && typeof data.hint === "string") {
        setText(data.hint);
        // Resync the page's server state (spent total, owned set) — the
        // revealed text itself stays in local state so it shows instantly.
        router.refresh();
      } else {
        setError(data.error === "not-launched" ? "The event hasn't launched yet." : typeof data.error === "string" ? data.error : "Couldn't reveal the hint. Try again.");
      }
    } catch {
      setError("Couldn't reveal the hint. Try again.");
    } finally {
      setPending(false);
    }
  }

  // Announced, because this text REPLACES the button that was focused: without
  // a live region the click consumed points and produced silence for a
  // screen-reader user, with focus dropped to the document body.
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
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={reveal}
        disabled={pending}
        className="w-fit rounded-md border border-[#d4a017]/40 px-3 py-1.5 text-sm text-[#d4a017] transition-colors hover:bg-[#d4a017]/10 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
      >
        {pending ? (
          "Revealing…"
        ) : (
          <>
            <span aria-hidden="true">💡</span> Reveal hint (−{cost} pts)
          </>
        )}
      </button>
      {error && (
        <p role="alert" className="text-xs text-[#e53e3e]">
          {error}
        </p>
      )}
    </div>
  );
}
