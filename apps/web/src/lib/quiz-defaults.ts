/**
 * Quiz retry-gate defaults that BOTH the server and the admin UI need.
 *
 * Same reason as `hint-defaults.ts`: `quiz-store.ts` is `server-only`, so the
 * admin panel — a Client Component — cannot import from it. When the panel
 * cannot see the default it renders an EMPTY box, and an empty box next to
 * help text reading "0 = unlimited" tells the organizer the opposite of the
 * truth.
 *
 * Deliberately dependency-free: no `server-only`, no Redis, no env reads.
 */

/** Graded attempts per question before the retry gate refuses more.
 *  0 would mean unlimited — which is NOT the default. */
export const QUIZ_MAX_ATTEMPTS = 3;

/** Minutes after a login's last attempt on a question before it may try
 *  again. 0 would mean no cooldown — which is NOT the default. One minute
 *  keeps a brute-force deterrent on few-option questions without locking a
 *  contestant out for long after an honest wrong guess (#549); organizers
 *  raise it per event in /admin. */
export const QUIZ_RETRY_AFTER_MIN = 1;
