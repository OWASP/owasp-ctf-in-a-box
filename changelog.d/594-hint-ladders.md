- **Added: Jeopardy hints are now an ordered, independently priced ladder
  (#594).** A challenge can carry several hints, bought in order — hint 2 only
  after hint 1 — each with its own price (or blank to use the event-wide
  `hintCost`). The challenge page shows how many rungs exist and every rung's
  price before purchase, renders an owned rung's text, and offers the next
  rung's buy button; the Jeopardy editor gains a ladder field with add, move
  and remove. Storage is additive: rung `N` is the field `<id>#<n>` in
  `ctf:classic:hints` (level 1 stays the bare id, so existing single hints
  read as hint 1 with no migration), per-rung prices live in
  `ctf:classic:hintcosts`, and the price actually charged is recorded per
  purchase in `ctf:hints:cost:<player>`. Ordering, the authoritative price
  re-read and the client-confirmed quote (#557) are enforced atomically in the
  reveal script — a stale quote is refused with `409` and nothing read. Bundle
  version 5 exports/imports the ladder (on top of version 4's challenge
  visibility) and still reads v1-v4 single hints as a one-rung list; Insights
  adds a "hints by level" table (buyers, spend, before/after solving).
  `ctf:hints:spent` stays the points penalty it always was. Secure Development
  keeps a single hint.
