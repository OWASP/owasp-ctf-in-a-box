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

// The fence a context's writes check. `withWriteFence` fixes it for a call;
// `withWriteFenceSlot` opens it empty for a request whose fence is only
// known partway through, which `setWriteFence` then fills.
type Slot = { fence: WriteFence | null };

const fences = new AsyncLocalStorage<Slot>();

/** Runs `fn` with every auth-store create and update it makes fenced on `fence`. */
export function withWriteFence<T>(fence: WriteFence, fn: () => Promise<T>): Promise<T> {
  return fences.run({ fence }, fn);
}

/**
 * Runs `fn` with an empty fence that code inside it can set. better-auth runs
 * a database hook and the write it guards in one call of its own, so the hook
 * cannot wrap that write in `withWriteFence`; it sets the fence of the
 * request it runs in instead (the auth route opens one for every request).
 */
export function withWriteFenceSlot<T>(fn: () => Promise<T>): Promise<T> {
  return fences.run({ fence: null }, fn);
}

/** Sets (or, with null, clears) the fence of the slot the current context
 *  runs in. False when there is none, so a caller that needs a fence can
 *  refuse instead of writing unfenced. */
export function setWriteFence(fence: WriteFence | null): boolean {
  const slot = fences.getStore();
  if (!slot) return false;
  slot.fence = fence;
  return true;
}

/** The fence the current async context runs under, or null. */
export function currentWriteFence(): WriteFence | null {
  return fences.getStore()?.fence ?? null;
}
