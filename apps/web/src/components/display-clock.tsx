"use client";

// The projector board's clock (#543 P2): "starts in …", "ends in …", "final"
// or "not launched", from the scoring window, re-rendered once a second. The
// text itself is the pure clockText (lib/display-clock.ts). The first render
// happens on the server with the server's clock and the browser corrects it
// on the first tick, so the span opts out of the hydration text check (and
// is rendered even when empty — see below).

import { useEffect, useState } from "react";
import { clockText } from "@/lib/display-clock";

export default function DisplayClock({ startsAt, endsAt }: { startsAt: string | null; endsAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // Always the same element, empty text included: the server may render
  // "starts in 00:00:01" and the browser hydrate a moment later into "live,
  // no end" (""). A vanished span would be an element mismatch, which
  // suppressHydrationWarning does not cover — it only forgives text.
  const text = clockText(now, startsAt, endsAt);
  return (
    <span suppressHydrationWarning className="font-mono text-[2vh] tabular-nums tracking-widest text-white">
      {text}
    </span>
  );
}
