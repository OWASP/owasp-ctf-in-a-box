// User-facing copy for password reset codes, shared by the API route and the
// /reset form. Client-safe: no `server-only`, no Redis.

/** The ONE refusal for a code that reset nothing: malformed, spent, expired,
 *  replaced and never issued all read the same. */
export const RESET_CODE_INVALID_COPY = "That reset code is not valid. Ask an organizer for a new one.";

export const RESET_DONE_COPY = "Password changed. Sign in with your new password.";
