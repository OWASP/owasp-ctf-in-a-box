"use client";

// The projector board's clock (#543 P2): "starts in …", "ends in …", "final"
// or "not launched", from the scoring window, re-rendered once a second. The
// text itself is the pure clockText (lib/display-clock.ts). The first render
// happens on the server with the server's clock and the browser corrects it
// on the first tick, so the span opts out of the hydration text check.

import { useEffect, useState } from "react";
import { clockText } from "@/lib/display-clock";

export default function DisplayClock({ startsAt, endsAt }: { startsAt: string | null; endsAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const text = clockText(now, startsAt, endsAt);
  if (!text) return null;
  return (
    <span suppressHydrationWarning className="font-mono text-[2vh] tabular-nums tracking-widest text-white">
      {text}
    </span>
  );
}
