// The shared 404 body: a heading, the terminal flourish, and a directory of
// routes this event actually has.
//
// Extracted so a module route can 404 with copy that is TRUE. The generic
// "the link is just wrong or out of date" is right for a typo and wrong for a
// module an organizer switched off mid-event (issue #175): the link was
// correct, the visitor may have had the page open a minute ago, and telling
// them their link is stale sends them looking for a better one that does not
// exist. See `(site)/quiz/not-found.tsx` and its siblings.
//
// Renders NO footer. The root `not-found.tsx` sits outside the `(site)` group
// and adds its own; the per-module boundaries are inside that group and
// inherit its layout, so putting one here would double it up.

import Link from "next/link";
import PageHeader from "@/components/page-header";
import { joinAppNames } from "@/lib/apps";
import { getEnabledApps } from "@/lib/enabled-apps";
import type { RulesContext } from "@/lib/modules";
import { getModuleRouteCard, getResolvedModules } from "@/lib/resolved-modules";

// Where a lost visitor is offered to go next. Platform routes only — the
// module ones are spliced in ahead of these, per module, so the 404 can never
// again offer a card to /challenges on an event that has no such route (it
// 404'd straight back, from the 404 page, while the footer directly beneath it
// listed the module route that DID exist).
const platformRoutes = [
  { href: "/how-to-play", label: "How to Play", body: "The full loop, with a worked example." },
  { href: "/leaderboard", label: "Leaderboard", body: "Live standings for contestants and teams." },
  { href: "/faq", label: "FAQ", body: "Answers to what contestants ask most." },
];

export type NotFoundRoute = { href: string; label: string; body: string };

/** The route directory, resolved. Separate from the component, and awaited by
 *  the CALLER, because a `not-found.tsx` that returns an async child suspends
 *  under `renderToStaticMarkup` — React reports that as "a component suspended
 *  while responding to synchronous input", which names neither the component
 *  nor the await. Passing plain data down keeps every 404 boundary renderable
 *  in one pass, the same way the rest of this app hands server data to its
 *  components. */
export async function getNotFoundRoutes(): Promise<NotFoundRoute[]> {
  const enabledApps = await getEnabledApps();
  const ctx: RulesContext = {
    appCount: enabledApps.length,
    appList: joinAppNames(enabledApps.map((a) => a.name)),
  };
  // Label and href off the resolved module (so an organizer's rename shows up
  // here exactly as it does in the nav — `titleOverride`, not `title`, for the
  // reason spelled out on ResolvedModule); the body off the registry's
  // server-only `routeCard`, which is a function and therefore never rides on
  // the resolved object. A module with no route, or no card, contributes none.
  //
  // `getResolvedModules()` is the LIVE set, so a module switched off is absent
  // from these cards — which is the whole reason this page can be trusted to
  // offer somewhere that works.
  const moduleRoutes = (await getResolvedModules()).flatMap((module) => {
    const card = getModuleRouteCard(module.id);
    if (!module.nav || !card) return [];
    return [
      {
        href: module.nav.href,
        label: module.titleOverride || module.nav.label,
        body: card(ctx),
      },
    ];
  });
  return [...moduleRoutes, ...platformRoutes];
}

export default function NotFoundBody({
  eyebrow = "404",
  title,
  description,
  routes,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  routes: readonly NotFoundRoute[];
}) {
  return (
    <div className="flex flex-col gap-10">
      <PageHeader eyebrow={eyebrow} title={title} description={description} />

      <div className="rounded-lg border border-white/[0.06] bg-[#12121e] px-6 py-3.5 font-mono text-sm text-muted">
        <span className="text-[#22c55e]">$</span> ctf goto{" "}
        <span className="text-zinc-400">--route</span> <span>not_found</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {routes.map((r) => (
          <Link
            key={r.href}
            href={r.href}
            className="ds-card rounded-lg border border-white/[0.06] bg-[#16162a] p-5 transition-colors hover:border-[#2563eb]/40"
          >
            <h2 className="font-semibold text-white">{r.label}</h2>
            <p className="mt-1 text-sm leading-relaxed text-zinc-400">{r.body}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
