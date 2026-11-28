import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { withWriteFenceSlot } from "@/lib/auth-store/write-fence";

// Each request gets a write fence its database hooks can set: a profile link
// callback fences its GitHub account write on its link claim
// (refuseSecondGithubLinkOnCallback).
export const { GET, POST } = toNextJsHandler((request: Request) => withWriteFenceSlot(() => auth.handler(request)));
