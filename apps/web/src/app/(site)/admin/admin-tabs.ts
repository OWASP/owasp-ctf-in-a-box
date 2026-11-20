// The admin panel's URL⇄tab rules, in a module with NO `"use client"` marker.
//
// All three are needed on BOTH sides of the RSC boundary: the two routes
// resolve a request's tab on the server (`page.tsx`, `[tab]/page.tsx`), while
// the sidebar's `href`, the pushState after a click and the popstate handler
// all run in the browser. They lived in admin-controls.tsx, which is a Client
// Component — and a function exported from a `"use client"` module is a client
// REFERENCE, not a callable. Calling one from a Server Component throws
//
//   Error: Attempted to call resolveAdminTab() from the server but
//   resolveAdminTab is on the client.
//
// at request time, which took every `/admin` URL to the error boundary in
// production while `next build`, vitest and CI all stayed green (issue #312):
// there is no RSC boundary in the unit tests, so `"use client"` is inert there
// and the call succeeds. Nothing but a real request could see it.
//
// So the rules live here and admin-controls.tsx re-exports them for its client
// callers — the same shape `team-limits.ts` and `admin-grants.ts` already use,
// for the same reason: what a module imports is part of its contract. Keep this
// file dependency-free and free of `"use client"`; importing anything that
// carries the marker would put it back on the client side of the boundary.

/** The canonical URL for a tab. One builder, used by the sidebar's `href`,
 *  by the pushState that follows a click, and by the tests — so the link an
 *  organizer copies and the panel they are looking at cannot disagree. */
export function adminTabHref(id: string): string {
  return `/admin/${id}`;
}

/** Which tab a URL names, given its two possible sources: the `/admin/<tab>`
 *  path segment and the `?tab=` of the older form. ONE rule, used by both
 *  routes on the server and by the popstate handler on the client — the
 *  alternative is `/admin/overview?tab=admins` opening different panels
 *  depending on whether you loaded it or navigated to it.
 *
 *  An explicit `?tab=` wins: it is the more specific of the two, and it is
 *  what an old bookmark or doc link carries. Repeated `?tab=` values are
 *  treated as absent rather than picking one — a request that says two
 *  different things has said nothing usable, and falling through to the path
 *  (or Overview) beats guessing.
 *
 *  Returns "" when neither names a tab; the caller reads that as Overview. */
export function resolveAdminTab(pathTab: string | undefined, tabQuery: string | string[] | undefined): string {
  // Counted BEFORE empties are dropped: `?tab=&tab=admins` supplied the
  // parameter twice, so it is unusable by the rule above even though only one
  // half carries a value. Filtering first would have quietly picked `admins`.
  const values = Array.isArray(tabQuery) ? tabQuery : tabQuery == null ? [] : [tabQuery];
  if (values.length === 1 && values[0]) return values[0];
  return pathTab ?? "";
}

/** `resolveAdminTab` for a browser location — what the popstate handler has.
 *  Decoding is guarded: history can hold `/admin/%`, and a throwing
 *  `decodeURIComponent` there would leave the panel out of step with the URL
 *  instead of falling back to Overview. */
export function tabFromLocation(pathname: string, search: string): string {
  const match = /^\/admin\/([^/?#]+)/.exec(pathname);
  let pathTab: string | undefined;
  if (match) {
    try {
      pathTab = decodeURIComponent(match[1]);
    } catch {
      pathTab = undefined;
    }
  }
  return resolveAdminTab(pathTab, new URLSearchParams(search).getAll("tab"));
}
