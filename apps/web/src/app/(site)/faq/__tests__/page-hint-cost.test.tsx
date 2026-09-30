// The FAQ's hint answer quotes a PRICE, and the price is an /admin runtime
// setting — any integer in [0, HINT_COST_MAX], not a constant.
//
// It shipped as the literal "10 points" (issue #315), so every organizer who
// moved the price served a FAQ that misquoted it, while `/challenges`, the
// reveal button and the challenge pages all rendered the real one. This file
// is the guard: the number on the page comes from the resolved config.
//
// Own file for the usual `vi.mock` hoisting reason, and because it needs the
// Upstash env set before `hint-store` is imported — `getHintNotice` short-
// circuits to the baked default when the credentials are absent, which would
// make an assertion on the configured value pass for the wrong reason.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The organizer's configured price. Deliberately NOT 10: a test written
// against the default cannot tell a live read from the hardcoded literal it
// replaced.
const CONFIGURED_HINT_COST = 25;

vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake.upstash.io");
vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fake-token");

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["secure-development"]),
);
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` reads `moduleOverrides` from this; `enabledModuleIds`
  // mirrors the set the enabled-modules mock above serves.
  getAdminSettings: async () => ({
    moduleOverrides: {},
    enabledModuleIds: ["secure-development"],
    hintsEnabled: true,
    hintCost: CONFIGURED_HINT_COST,
    hintsMinSolves: null,
    hintsUnlockAfterMin: null,
    scoringStartsAt: null,
  }),
}));
// secure-development owns the hints answer today.

const Faq = (await import("@/app/(site)/faq/page")).default;
const html = await Faq().then(renderToStaticMarkup);

describe("/faq quotes the organizer's hint price", () => {
  it("renders the configured cost", () => {
    expect(html).toContain(`Revealing a hint costs ${CONFIGURED_HINT_COST} points`);
  });

  it("does not carry the baked default once the organizer has set a price", () => {
    // The defect exactly: the literal survived a config change. Guarded as the
    // full phrase rather than the bare number so an unrelated "10" elsewhere
    // on the page cannot fail this.
    expect(html).not.toContain("Revealing a hint costs 10 points");
  });
});
