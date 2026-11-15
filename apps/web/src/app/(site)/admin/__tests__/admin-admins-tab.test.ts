// @vitest-environment happy-dom
// The Admins tab's copy and first render. The rows and an issued code are
// behind `useState` and this repo has no @testing-library/act to observe a
// live re-render (see admin-support-tab.test.tsx), so the stateful copy is
// pinned through the exported pure values instead of markup.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import AdminAdminsTab, { ISSUE_HELP, codeNotice } from "@/app/(site)/admin/admin-admins-tab";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

describe("an issued code", () => {
  const CODE = "0123-4567-89ab-cdef-0123-4567-89ab-cdef";

  it("is cleared when the tab is hidden, so it does not show again on return", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/admin/codes"
          ? new Response(JSON.stringify({ code: CODE, expiresAt: "2026-11-15T12:34:00.000Z" }), { status: 200 })
          : new Response(JSON.stringify({ admins: [] }), { status: 200 }),
      ),
    );
    const view = render(createElement(AdminAdminsTab, { viewerId: "x", visible: true }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Issue admin code" }));
    });
    expect(await screen.findByText(CODE)).toBeTruthy();
    view.rerender(createElement(AdminAdminsTab, { viewerId: "x", visible: false }));
    view.rerender(createElement(AdminAdminsTab, { viewerId: "x", visible: true }));
    expect(screen.queryByText(CODE)).toBeNull();
  });
});
