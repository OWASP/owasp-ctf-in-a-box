// /challenges must 404 on an event that never enabled secure-development —
// not just have its nav entry disappear.
//
// Own file because `vi.mock` hoists per file and this fixture needs its own
// module set — same split as lib/__tests__/modules-resolve.test.ts and
// app/__tests__/page-quiz-only.test.tsx.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["quiz"]),
);

import ChallengesPage from "@/app/(site)/challenges/page";

describe("/challenges on a quiz-only event", () => {
  it("404s — the route must not be reachable even though it isn't in the nav", async () => {
    await expect(ChallengesPage()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });
});
