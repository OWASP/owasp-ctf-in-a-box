// @testing-library/react is not a dependency of this repo and there is no
// jsdom either — see nav-dropdown.test.tsx for the same constraint on the
// same grounds. A closed-by-default static render is enough to prove the
// wordmark: it's outside any `useState` toggle, so it always appears.
//
// SiteHeader calls `usePathname()` directly (to highlight the active link),
// so — unlike NavDropdown, which takes `isActive` as a prop — this file must
// mock `next/navigation` before importing the component. It also mounts
// <AuthNav>, which reads the session and `useRouter()` — orthogonal to the
// wordmark, and stubbed out the same way site-nav-parity.test.tsx does.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/components/auth-nav", () => ({ default: () => null }));

const { default: SiteHeader } = await import("@/components/site-header");

describe("SiteHeader", () => {
  it("renders the runtime event name in the wordmark", () => {
    const html = renderToStaticMarkup(
      <SiteHeader navLinks={[]} discordUrl="" eventName="OWASP CTF in a Box" />,
    );
    expect(html).toContain("OWASP CTF in a Box");
  });

  it("shows an organizer-renamed event, not a hardcoded name", () => {
    const html = renderToStaticMarkup(
      <SiteHeader navLinks={[]} discordUrl="" eventName="BSides Rivertown" />,
    );
    expect(html).toContain("BSides Rivertown");
    expect(html).not.toContain("owasp-ctf");
  });
});
