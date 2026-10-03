import "server-only";
import { isModuleLive } from "@/lib/enabled-modules";
import type { LeaderboardData, UserProfile } from "./types";
import { mockSource } from "./mock";
import { lambdaSource } from "./lambda";
import { upstashSource } from "./upstash";
import { emptySource } from "./empty";

export interface LeaderboardSource {
  getLeaderboard(options?: { fresh?: boolean }): Promise<LeaderboardData>;
  getUser(login: string): Promise<UserProfile | null>;
}

/**
 * `LEADERBOARD_SOURCE` switches the backend without touching any UI code:
 *  - "mock"    (default) — local fixture shaped like the proposed v2 API.
 *  - "lambda"  — the deployed Lambda's `GET /leaderboard` (live scoring;
 *                per-app solved/total, no per-challenge or point breakdown).
 *  - "upstash" — direct read of the CURRENT real Upstash schema (read-only
 *                token) — aggregates only, no teams, no per-app breakdown.
 *
 * An event with no scored module (`secure-development` disabled) ignores the
 * variable entirely and resolves to the "empty" mode — see
 * getLeaderboardSourceMode and ./empty.ts.
 */
const VALID_MODES = ["mock", "lambda", "upstash"] as const;

/** The modes an organizer can actually configure. */
type ConfiguredMode = (typeof VALID_MODES)[number];

/** …plus "empty", which is never configured: it is what an event with no
 *  scored module resolves to regardless of what `LEADERBOARD_SOURCE` says. */
export type LeaderboardSourceMode = ConfiguredMode | "empty";

function isValidMode(value: string | undefined): value is ConfiguredMode {
  return (VALID_MODES as readonly string[]).includes(value ?? "");
}

/** Unrecognised values are only ever warned about once each. This runs per
 *  request, so the dedup matters — an un-deduped warn would flood logs. */
const warnedValues = new Set<string>();

export async function getLeaderboardSourceMode(): Promise<LeaderboardSourceMode> {
  // Checked BEFORE the env var, and deliberately not overridable by it: with
  // `secure-development` disabled there is no scorer, no lambda and no Upstash
  // scoring data for this event, so every configured source is wrong rather
  // than misconfigured — pointing at a backend that was never deployed is not
  // a mistake the organizer can fix by editing a value. The board is built
  // entirely by the module overlays on top of `emptySource` instead. This also
  // keeps the "mock" mode (and with it /leaderboard's placeholder-data banner)
  // off a board that carries real module points.
  if (!(await isModuleLive("secure-development"))) return "empty";

  const mode = process.env.LEADERBOARD_SOURCE;
  if (isValidMode(mode)) return mode;
  // A typo here fails toward placeholder data rather than toward an error, so
  // say so loudly — the only other signal is the amber banner on /leaderboard.
  if (mode && !warnedValues.has(mode)) {
    warnedValues.add(mode);
    console.warn(
      `[leaderboard] unknown LEADERBOARD_SOURCE "${mode}" — falling back to "mock", ` +
        `so the board will serve placeholder data instead of real scores. ` +
        `Valid values: ${VALID_MODES.join(", ")}.`,
    );
  }
  return "mock";
}

export async function getLeaderboardSource(): Promise<LeaderboardSource> {
  switch (await getLeaderboardSourceMode()) {
    case "lambda":
      return lambdaSource;
    case "upstash":
      return upstashSource;
    case "mock":
      return mockSource;
    case "empty":
      return emptySource;
  }
}
