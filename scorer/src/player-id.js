// A player id is a lowercase v4 UUID minted by the app (apps/web/src/lib/player.ts
// holds the same pattern). Lowercase makes the team-roster join exact, and no
// id holds ":", which the solves hash relies on to split `<player>:<challenge>`.
export const PLAYER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
