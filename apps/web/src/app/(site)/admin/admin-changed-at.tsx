"use client";

// The settings audit line's clock: who last changed the settings, and when,
// as "4m ago" rather than a raw ISO instant. Extracted from
// admin-controls.tsx (issue #504, M11) so the shell stays a shell; the shell
// still renders the line itself and passes the instant in.

import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/relative-time";

/** The audit line's timestamp, as "4m ago" rather than a raw ISO instant.
 *
 *  Renders nothing until mounted, for the same reason the countdowns do: this
 *  is a Client Component that still server-renders, and relative time read
 *  from a live clock during render disagrees with the server's render. So the
 *  server paints "last changed by alice" and the time appears on hydration.
 *
 *  The exact instant stays available on hover via `title` — an organizer
 *  reconciling an audit trail wants the precise value, just not in their face. */
export function ChangedAt({ iso }: { iso: string }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => setLabel(formatRelativeTime(iso));
    const timeout = setTimeout(tick, 0);
    // 30s, not 1s: this line ages in minutes and nobody is watching it count.
    const interval = setInterval(tick, 30_000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [iso]);

  if (!label) return null;
  return <time dateTime={iso} title={iso}>{label}</time>;
}
