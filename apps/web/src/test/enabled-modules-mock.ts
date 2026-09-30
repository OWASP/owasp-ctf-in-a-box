/**
 * Factory for a `vi.mock("@/lib/enabled-modules", ...)` stand-in. Each suite
 * states the live module set it wants, in the mock call itself:
 *
 *   vi.mock("@/lib/enabled-modules", async () =>
 *     (await import("@/test/enabled-modules-mock")).mockEnabledModules(["quiz"]));
 *
 * or, for a suite that flips the set per test, a predicate over a hoisted
 * `vi.fn` (read on every call, so a `mockReturnValue` in a test takes effect):
 *
 *   mockEnabledModules((id) => moduleLive(id))
 *
 * There is no default set: a suite that does not say which modules are live
 * does not get one. (The helper this replaces, `enabled-modules-baked.ts`,
 * fell back to "secure-development alone" and read the set off a fake
 * `isModuleEnabled` on `@/lib/modules` — a mimic of the event.yaml bake that
 * #386 deleted. #503 removed it.)
 *
 * Why a stand-in is needed at all: the real resolver calls `connection()` to
 * keep itself out of Next's build-time prerender, and `connection()` throws
 * outside a request scope — a unit test calling a page function directly has
 * none.
 */
import type { ModuleId } from "@/lib/modules";

const KNOWN: readonly ModuleId[] = ["secure-development", "quiz", "classic", "ai"];

// `getResolvedModules` (in `@/lib/resolved-modules`) reads its settings
// snapshot through `getAdminSettingsSnapshot`, so a suite that renders module
// names still needs one that returns `moduleOverrides` (organizer renames).
// It delegates to whatever the suite mocked on `@/lib/admin-store` (or lets
// the unmocked one fail open to `null`), exactly as the real one does.
//
// Imported LAZILY and memoized: `@/lib/admin-store` carries
// `import "server-only"`, which throws outside Next's RSC bundling unless a
// test mocks it, and most suites here never reach this function. Caching the
// promise (not its value) keeps two concurrent first callers from racing
// Vitest's module runner into one mocked and one real module.
let adminStoreImport: Promise<typeof import("@/lib/admin-store")> | undefined;

async function getAdminSettingsSnapshot() {
  try {
    adminStoreImport ??= import("@/lib/admin-store");
    const { getAdminSettings } = await adminStoreImport;
    return await getAdminSettings();
  } catch {
    return null;
  }
}

export function mockEnabledModules(live: readonly ModuleId[] | ((id: ModuleId) => boolean)) {
  const isLive = typeof live === "function" ? live : (id: ModuleId) => live.includes(id);
  const ids = () => KNOWN.filter((id) => isLive(id));
  return {
    // The real one is the deployment's own default set (what a box with no
    // stored module toggles runs); here that is the suite's live set. A
    // getter, so a predicate a test flips is read at the moment of use.
    get defaultModuleIds(): readonly ModuleId[] {
      return ids();
    },
    getAdminSettingsSnapshot,
    getEnabledModuleIds: async (): Promise<ReadonlySet<ModuleId>> => new Set(ids()),
    isModuleLive: async (id: ModuleId): Promise<boolean> => ids().includes(id),
  };
}
