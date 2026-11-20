// User-facing copy for password reset codes, shown by the /reset form. The
// route answers with error codes only and the form maps them to this copy.
// Client-safe: no `server-only`, no Redis.

/** The ONE refusal for a code that reset nothing: malformed, spent, expired,
 *  replaced and never issued all read the same. */
export const RESET_CODE_INVALID_COPY = "That reset code is not valid. Ask an organizer for a new one.";

export const RESET_DONE_COPY = "Password changed. Sign in with your new password.";

/** A 503: the code may already be spent, so retrying it may not help. */
export const RESET_UNAVAILABLE_COPY = "Something went wrong. Ask an organizer for a new code if this keeps happening.";
