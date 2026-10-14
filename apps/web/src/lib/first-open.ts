// When a player first opened a Jeopardy or AI challenge's page, the start of
// Insights' "open → solve" time. Written by the box on its own page
// render, so it needs nothing from a fork or the external AI site (ADR 46's
// boundary is untouched). HSETNX: the first open sticks, later visits never
// move it.
//
// A metric, not a gate: a failed write is logged and the page renders as
// usual. The cost of a miss is one solve measured from the first submission
// instead, which Insights labels as such.

import "server-only";
import { aiOpenedKey } from "@/lib/ai-keys";
import { classicOpenedKey } from "@/lib/classic-keys";
import { errorLabel } from "@/lib/error-label";
import { upstashPipeline } from "@/lib/upstash";

const KEY = { classic: classicOpenedKey, ai: aiOpenedKey } as const;

export async function recordFirstOpen(module: "classic" | "ai", login: string, id: string): Promise<void> {
  try {
    const [res] = await upstashPipeline([["HSETNX", KEY[module](login), id, new Date().toISOString()]]);
    if (res?.error) console.error(`first-open record failed (${module}):`, res.error);
  } catch (err) {
    console.error(`first-open record failed (${module}):`, errorLabel(err));
  }
}
