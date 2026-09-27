// Bounded request-body reads, shared by the admin routes that accept a large
// body (sponsor logos, attachment uploads #186). The cap is checked against
// bytes actually read off the stream, not the client-supplied
// `Content-Length`, which a caller can omit or understate — "authenticated" is
// not "trusted with unbounded memory". "Too large" and "stream broke" are kept
// apart so a caller answers 413 for one and 400 for the other.

export type BoundedBytesResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" | "stream_error" };
export type BoundedBodyResult = { ok: true; body: string } | { ok: false; reason: "too_large" | "stream_error" };

export async function readBoundedBytes(request: Request, maxBytes: number): Promise<BoundedBytesResult> {
  const reader = request.body?.getReader();
  if (!reader) return { ok: true, bytes: new Uint8Array(0) };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "stream_error" };
  }
  return { ok: true, bytes: new Uint8Array(Buffer.concat(chunks)) };
}

export async function readBoundedBody(request: Request, maxBytes: number): Promise<BoundedBodyResult> {
  const r = await readBoundedBytes(request, maxBytes);
  return r.ok ? { ok: true, body: Buffer.from(r.bytes).toString("utf-8") } : r;
}
