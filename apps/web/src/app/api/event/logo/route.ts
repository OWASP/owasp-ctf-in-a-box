import { serveEventImage } from "@/lib/event-image-response";

/** PUBLIC: the event's logo (#529) — see event-image-response.ts. Reads live
 *  Redis state on every request that isn't answered by a 304. */
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return serveEventImage("logo", request);
}
