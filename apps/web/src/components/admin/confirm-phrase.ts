// The phrase a delete confirmation makes an organizer retype — shared by the
// quiz (a question's prompt) and classic (a challenge's title) admin
// panels.
//
// The phrase is the item's own human-readable text, never its id: reading an
// id back proves only that someone can copy a string, not that they know
// WHICH item is about to disappear, which is the entire job of the gate. The
// truncation is applied ONCE by the caller and the result used for BOTH the
// modal's title and its `requireType`, so what the organizer reads is exactly
// what they must type.

/** Longest phrase the delete confirmation asks an organizer to retype, counted
 *  in CODE POINTS rather than UTF-16 units (see `confirmPhrase`). A prompt or
 *  title can run to a paragraph; making someone transcribe one verbatim turns
 *  a safety gate into a copy-paste ritual, which is the opposite of making
 *  them read it. */
export const DELETE_CONFIRM_PHRASE_MAX = 48;

/** `text`, whitespace-collapsed and — if long — cut at the last word boundary
 *  inside `DELETE_CONFIRM_PHRASE_MAX`.
 *
 *  The cut is by code point (`Array.from`), never `slice`. Slicing on UTF-16
 *  indices splits any non-BMP character — an emoji, a rarer CJK ideograph —
 *  that straddles the limit, and the surviving lone high surrogate lands in
 *  `requireType`: a phrase no keyboard can produce, so the gate never opens
 *  and that item cannot be deleted from the panel at all (#281). The
 *  word-boundary rule below usually hides this, but a first word longer than
 *  the limit takes the no-space branch straight into it.
 *
 *  Code points, not grapheme clusters: a ZWJ emoji sequence can still be
 *  halved here. That half is typeable — each component is a real character the
 *  organizer can see and copy — so the gate stays operable, which is the
 *  property being protected.
 *
 *  A blank/whitespace-only `text` yields `fallback`. `ConfirmModal` treats an
 *  empty `requireType` as "no confirmation required", so a challenge with a
 *  blank title would otherwise delete on one click; classic passes the
 *  item's id (always non-empty by its id regex) for exactly that case. The
 *  quiz passes nothing — a question's prompt is required non-empty — and gets
 *  the empty string it always did. */
export function confirmPhrase(text: string, fallback: string = ""): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length === 0) return fallback;
  const points = Array.from(clean);
  if (points.length <= DELETE_CONFIRM_PHRASE_MAX) return clean;
  const cut = points.slice(0, DELETE_CONFIRM_PHRASE_MAX).join("");
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}
