import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A condition every auth-store row write made inside `withWriteFence` checks
 * in the same EVAL as the write: the set at `key` must still hold `member`,
 * or the write is refused and nothing changes (PUT_ROW_SCRIPT returns 3, the
 * adapter throws). A deadline the caller keeps in Redis, as the member of a
 * set with a TTL, then bounds the write on Redis's clock: a write that
 * reaches Redis after the set expired, or after the caller removed its
 * member, cannot land, however long the request was delayed on the way.
 *
 * Only creates and updates are fenced. Deletes are not: a late delete only
 * removes access, and refusing it would leave rows the caller meant to drop.
 */
export type WriteFence = { key: string; member: string };

const fences = new AsyncLocalStorage<WriteFence>();

/** Runs `fn` with every auth-store create and update it makes fenced on `fence`. */
export function withWriteFence<T>(fence: WriteFence, fn: () => Promise<T>): Promise<T> {
  return fences.run(fence, fn);
}

/** The fence the current async context runs under, or null. */
export function currentWriteFence(): WriteFence | null {
  return fences.getStore() ?? null;
}
