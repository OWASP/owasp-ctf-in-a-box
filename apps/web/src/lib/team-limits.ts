/**
 * Team size limits, in a module with NO `server-only` marker.
 *
 * Both numbers are needed on both sides: the server enforces them (team-store's
 * join transaction, admin-store's validation) and the admin panel — a Client
 * Component — renders them as the field's placeholder and `max`. Importing
 * either store from the client fails at build with
 *
 *   This module cannot be imported from a Client Component module.
 *
 * so the constants live here and the stores re-export them. Same reason
 * `admin-grants.ts` exists: what a module imports is part of its contract.
 */

/** Default players per team, used when the organizer has set no override.
 *  Resolve with team-store's `resolveTeamMaxMembers()` — never read this
 *  directly to decide whether a team is full (ADR 31). */
export const TEAM_MAX_MEMBERS = 4;

/** Upper bound accepted for the override. Not a product opinion — a guard so a
 *  typo cannot store a number that makes "team is full" unreachable. */
export const TEAM_MAX_MEMBERS_MAX = 100;
