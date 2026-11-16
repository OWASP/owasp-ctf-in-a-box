// better-auth's user row requires a unique email, and a username account has
// none. `.invalid` is reserved by RFC 2606 and never resolves, so nothing is
// ever delivered to a placeholder, and no real address can collide with one.
const PLACEHOLDER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@accounts\.invalid$/;

/** A fresh, never-deliverable email for a username account's row. */
export function placeholderEmail(): string {
  return `${crypto.randomUUID()}@accounts.invalid`;
}

/** True for an address placeholderEmail() minted, which is no one's mailbox. */
export function isPlaceholderEmail(email: string): boolean {
  return PLACEHOLDER_RE.test(email);
}
