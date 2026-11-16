import { createAuthClient } from "better-auth/react";
import { inferAdditionalFields, usernameClient } from "better-auth/client/plugins";
import type { auth } from "./auth";

// Sign-up goes through `authClient.$fetch("/sign-up/email", { method: "POST",
// body: { username, password } })`: the typed `signUp.email` requires an
// email, and the server sets a placeholder one itself.
export const authClient = createAuthClient({
  plugins: [inferAdditionalFields<typeof auth>(), usernameClient()],
});
