import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HeldScoresList } from "@/app/(site)/admin/admin-held-scores";
import AdminSecureDevTab from "@/app/(site)/admin/admin-secure-dev-tab";
import type { AdminSettings } from "@/lib/admin-store";

const entry = (over = {}) => ({
  login: "octo", target: "dvwa", solved: ["sqli-1", "xss-2"], pr: 7, at: "2026-11-19T10:00:00.000Z", status: "held" as const, ...over,
});

describe("HeldScoresList", () => {
  it("renders login, target, challenges, PR, time and status per row", () => {
    const html = renderToStaticMarkup(
      <HeldScoresList entries={[entry(), entry({ login: "zed", pr: 9, status: "unclaimed" })]} />,
    );
    for (const s of ["octo", "dvwa", "sqli-1, xss-2", "#7", "zed", "#9", "held", "unclaimed"]) expect(html).toContain(s);
    expect(html).toContain("2026-11-19T10:00:00.000Z");
  });

  it("shows the empty state", () => {
    expect(renderToStaticMarkup(<HeldScoresList entries={[]} />)).toContain("No held scores.");
  });

  it("has no buttons or inputs", () => {
    const html = renderToStaticMarkup(<HeldScoresList entries={[entry()]} />);
    expect(html).not.toMatch(/<(button|input|form|select)\b/);
  });
});

describe("AdminSecureDevTab", () => {
  it("carries the held and unclaimed scores section", () => {
    const html = renderToStaticMarkup(
      <AdminSecureDevTab
        settings={{ secureDevTargets: null } as unknown as AdminSettings}
        pending={false}
        apply={async () => true}
        applyField={async () => true}
        commitNumber={() => {}}
        statusOf={() => ({ state: "idle" })}
        cooldownInput=""
        setCooldownInput={() => {}}
      />,
    );
    expect(html).toContain("Held and unclaimed scores");
  });
});
