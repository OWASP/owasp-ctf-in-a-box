// Gated Server Component: real gate is requireAdmin (the same check the
// /api/admin/* routes use — no second auth path). A signed-in non-admin
// should SEE a friendly "not an organizer" wall rather than a redirect or a
// 404, since the auth boundary is already enforced upstream; this is just a
// courteous dead end.

import { headers } from "next/headers";
import Link from "next/link";
import PageHeader from "@/components/page-header";
import { phaseFromSettings } from "@/components/phase";
import { requireAdmin } from "@/lib/admin-auth";
import { countAdminGrants } from "@/lib/admin-grants";
import { getAdminSettings, getSyncStatus } from "@/lib/admin-store";
import { joinAppNames } from "@/lib/apps";
import { getEnabledApps } from "@/lib/enabled-apps";
import { defaultModuleIds } from "@/lib/enabled-modules";
import { adminClaimCodeHash, getGithubOrg } from "@/lib/bootstrap-env";
import type { ModuleSetupContent, OrgContext } from "@/lib/modules";
import { secureDevAvailable } from "@/lib/module-defaults";
import { getModuleSetup, getResolvedModules } from "@/lib/resolved-modules";
import { getSite } from "@/lib/site";
import AdminControls from "@/app/(site)/admin/admin-controls";
import AdminHeader from "@/app/(site)/admin/admin-header";

const WALL_NO_ADMINS =
  "No organizer has claimed this box yet. Open /admin/claim and enter the admin claim code whose hash is in .env.";
const WALL_NO_HASH =
  "ADMIN_CLAIM_CODE_HASH is not set or is not a SHA-256 — generate a code with openssl rand -hex 16, put the SHA-256 of that code in .env as ADMIN_CLAIM_CODE_HASH, and recreate the app container (docker compose up -d --no-deps --force-recreate app).";

export default async function AdminPanel({ tab }: { tab?: string }) {
  const gate = await requireAdmin(await headers());

  if (!gate.ok) {
    // Booleans only cross into the markup — never the hash, never the roster.
    // With nobody claimed, this wall is the one surface the organizer sees,
    // so it says how to get in. The count is best-effort: a read error shows
    // no notice rather than a wrong one.
    const noAdmins = await countAdminGrants().then(
      (n) => n === 0,
      () => false,
    );
    const noHash = adminClaimCodeHash() === "";
    return (
      <div className="flex flex-col gap-8">
        <PageHeader eyebrow="Admin" title="Forbidden" description="Organizer access only." />
        <div className="ds-card rounded-lg border border-white/[0.06] bg-[#16162a] px-5 py-10 text-center">
          <p className="text-sm text-zinc-400">
            You need to be an organizer to view this page. Have an admin claim code?{" "}
            <Link href="/admin/claim" className="ds-link">
              Enter it at /admin/claim
            </Link>
            .
          </p>
          {noAdmins && (
            <p role="alert" className="mt-3 text-sm text-[#e53e3e]">
              {WALL_NO_ADMINS}
            </p>
          )}
          {noAdmins && noHash && (
            <p role="alert" className="mt-3 text-sm text-[#e53e3e]">
              {WALL_NO_HASH}
            </p>
          )}
        </div>
      </div>
    );
  }

  // Independent catches: a Redis read failure degrades the affected block to
  // "unavailable" rather than 500ing the whole page (spec: Error handling).
  // A `sync` read failure is folded into the existing "no poller yet" render
  // (both come back as null) — the poller heartbeat is advisory, not a
  // correctness signal, so collapsing the two cases is an acceptable
  // simplification rather than adding a second null-ish state to track.
  //
  // `getResolvedModules` is deliberately NOT wrapped in a catch: it already
  // fails open to the registry defaults internally (see
  // src/lib/resolved-modules.ts), and it is `cache()`d per request, so this
  // call rides along with whatever the root layout's nav already paid for.
  const [settings, sync, modules, site, enabledApps] = await Promise.all([
    getAdminSettings().catch(() => null),
    getSyncStatus().catch(() => null),
    getResolvedModules(),
    getSite(),
    getEnabledApps(),
  ]);

  // Each module's setup checklist, resolved HERE. The registry block is a
  // function of the org context (it names the targets and the GitHub org),
  // and AdminControls is a Client Component, so — exactly as /faq and
  // /how-to-play do for their blocks — the function is called on the server
  // and only its plain-data result is handed down. Built from the same
  // context the contestant pages use, so the setup panel and the FAQ can
  // never disagree about how many targets the event has.
  const ctx: OrgContext = {
    appCount: enabledApps.length,
    appList: joinAppNames(enabledApps.map((a) => a.name)),
    // "" is a misconfiguration the setup wizard refuses and `doctor` flags; prose that interpolates the org is not guarded here (#386).
    githubOrg: getGithubOrg(),
  };
  const setups: Partial<Record<string, ModuleSetupContent>> = {};
  for (const mod of modules) {
    const setup = getModuleSetup(mod.id);
    if (setup) setups[mod.id] = setup(ctx);
  }

  const resolution = settings ? phaseFromSettings(settings) : null;

  return (
    <div className="flex flex-col gap-8">
      <AdminHeader eventName={site.name} resolution={resolution} />

      {/* The sync heartbeat is no longer its own card: Overview renders it as
          a one-line health readout with the full breakdown behind a
          disclosure (admin-redesign.md). `sync` is still fetched here and
          handed down. */}
      {settings ? (
        <AdminControls
          initial={settings}
          defaultModuleIds={defaultModuleIds}
          secureDevAvailable={secureDevAvailable(process.env)}
          modules={modules}
          setups={setups}
          initialTab={tab}
          viewerId={gate.player.id}
          sync={sync}
          eventName={site.name}
        />
      ) : (
        <div className="ds-card flex flex-col gap-3 rounded-lg border border-white/[0.06] bg-[#16162a] p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Controls</h2>
          <p className="text-sm text-zinc-400">Settings unavailable — Redis unreachable.</p>
        </div>
      )}
    </div>
  );
}
