// `/admin/claim` — where a signed-in kit account enters an admin claim code
// (ADR 72). A static segment, so it wins over `/admin/[tab]`. Not behind
// requireAdmin: this is how a non-admin becomes one. The grant itself happens
// in POST /api/me/admin/claim; this page only decides which state to show.

import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import PageHeader from "@/components/page-header";
import { isAdminPlayer } from "@/lib/admin-auth";
import { getPlayer } from "@/lib/player";
import ClaimForm from "./claim-form";

export const metadata: Metadata = {
  title: "Claim admin",
  description: "Enter an admin claim code to become an organizer.",
};

const CARD = "ds-card rounded-lg border border-white/[0.06] bg-[#16162a] px-5 py-8";

export default async function AdminClaimPage() {
  const player = await getPlayer(await headers());

  let body: React.ReactNode;
  if (!player) {
    body = (
      <p className="text-sm text-zinc-400">
        Sign in first, then come back to /admin/claim and enter the code. The seat goes to the account you are
        signed in with.
      </p>
    );
  } else if (await isAdminPlayer(player.id).catch(() => false)) {
    body = (
      <p className="text-sm text-zinc-400">
        You are already an organizer.{" "}
        <Link href="/admin" className="ds-link">
          Open the admin panel
        </Link>
        .
      </p>
    );
  } else {
    body = <ClaimForm />;
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Admin"
        title="Claim admin"
        description="An admin claim code makes the account you are signed in with an organizer. Each code works once."
      />
      <div className={CARD}>{body}</div>
    </div>
  );
}
