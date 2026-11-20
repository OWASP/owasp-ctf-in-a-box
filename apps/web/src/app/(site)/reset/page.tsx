// Where a player redeems a password reset code an organizer issued them from
// /admin. Usable signed out: the player cannot sign in, which is why they are
// here. A signed-in visitor may use it too; a reset signs them out everywhere.

import type { Metadata } from "next";
import PageHeader from "@/components/page-header";
import ResetPasswordForm from "@/components/reset-password-form";

export const metadata: Metadata = { title: "Reset password" };

export default function ResetPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Account"
        title="Reset password"
        description="Enter the reset code an organizer gave you and choose a new password. Codes work once and expire after 15 minutes."
      />
      <ResetPasswordForm />
    </div>
  );
}
