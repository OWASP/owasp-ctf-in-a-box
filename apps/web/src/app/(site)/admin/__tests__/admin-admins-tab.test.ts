// The Admins tab's copy and first render. The rows and an issued code are
// behind `useState` and this repo has no @testing-library/act to observe a
// live re-render (see admin-support-tab.test.tsx), so the stateful copy is
// pinned through the exported pure values instead of markup.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AdminAdminsTab, { ISSUE_HELP, codeNotice } from "@/app/(site)/admin/admin-admins-tab";

describe("issued-code copy", () => {
  it("tells the issuer where the code goes and that it is single-use and short-lived", () => {
    expect(ISSUE_HELP).toContain("/admin/claim");
    expect(ISSUE_HELP).toContain("works once");
    expect(ISSUE_HELP).toContain("15 minutes");
  });

  it("says the code works once and when it expires", () => {
    const text = codeNotice("2026-11-15T12:34:00.000Z");
    expect(text).toContain("works once");
    expect(text).toContain("expires at");
  });
});

describe("first render", () => {
  it("offers to issue a code and has no field for a GitHub login", () => {
    const html = renderToStaticMarkup(createElement(AdminAdminsTab, { viewerId: "x" }));
    expect(html).toContain("Issue admin code");
    expect(html).not.toContain("github-login");
    expect(html).not.toContain('id="admin-login"');
  });
});
