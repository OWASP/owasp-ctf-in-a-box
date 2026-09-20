---
title: AI module
---

[← Docs home](index.md)

# AI module: the external integrator's contract

**For whoever builds the challenge site.** The `ai` module lets an organizer
list a challenge that is hosted entirely outside the box — an LLM red-team
exercise, a prompt-injection sandbox, anything with its own backend — and
still have it show up on the event's board, count toward a team's score, and
respect the event's pause/schedule/team rules. This document is everything an
external site needs to integrate: no box source access required. For where
`ai` sits among the platform's other modules, see
[docs/modules.md](modules.md); for why its two signatures use different key
types, see [ADR 53](decisions.md#adr-53-ai-launch-tokens-are-asymmetric-event-signatures-stay-symmetric).

## Section 0. The whole handshake, in one picture

<img src="assets/diagrams/ai-launch-token-flow.svg" alt="Animated diagram. The handshake between the box and an external AI challenge site, and which key does what. The box mints an Ed25519 JWT scoped to one challenge (sub is the player's login, aud is the challenge id, 24-hour expiry, jti as the replay nonce) and substitutes it into the challenge's launch URL wherever the operator wrote the {token} placeholder. The contestant opens that link on the external site, which fetches the module-wide public key from /api/ai/launch-key and caches it for about five minutes, re-fetching on any verification failure, then verifies with hard-coded Ed25519, never trusting the token's own alg or kid, pinning aud to the challenge it expects. The site re-reads GET /api/ai/state rather than trusting the token's mint-time progress snapshot. On a solve it POSTs /api/ai/event with the token and challenge id, signed with that challenge's own secret HMAC key over the exact string timestamp-dot-raw-body. The box checks the signature within 300 seconds, then the token, then claims the jti exactly once, so a replay gets 409, and the shared atomic award script banks the points. The launch key is public, one per event, and fetched; the signing key is secret, one per challenge, and pasted in from the admin panel.">

**Two keys, and they are not interchangeable** — this is the single most
common wiring mistake:

| | Launch key | Signing key |
|---|---|---|
| What it is | The box's Ed25519 **public** key | A **secret** HMAC key |
| How many | One per event | One per challenge |
| How you get it | `GET /api/ai/launch-key`; cache ~5 min, re-fetch on a verification failure and after an event reset (§3, §9) | Copy it from the admin panel's Reveal control |
| What you do with it | **Verify** the launch token | **Sign** the solve event you POST |
| If it leaks | Nothing. It is public by design | Anyone could assert solves for that challenge — rotate it |

The rest of this document is each step in detail. If you read only two
sections, read §3 (verifying) and §5 (the signature — where the expensive
mistake lives).

## Section 1. What you get, and what you owe

When a signed-in player with a team clicks "Open challenge" on `/ai/<id>`,
the box mints a **launch token** naming that player and that one challenge,
and substitutes it into the organizer's `urlTemplate` (`{token}` → the
token) to build the URL it sends them to. Your site's job is to verify that
token against the box's **published public key** before trusting anything in
it. From there you have two ways to report a solve back, and an organizer
picks one or both per challenge: your backend **POSTs a signed event** the
moment it decides the player solved it (`mode: "event"` or `"both"`), or the
player **types a flag** into a form your site renders, which you forward
to the box's own grading route (`mode: "flag"` or `"both"`).

Neither credential lets you invent a player. The public key you fetch can
only *verify* a launch token, never mint one — the box alone holds the
private half. The signing key you're issued per challenge can only prove
*your backend* sent an event; it says nothing about *who*, because identity
comes from the launch token instead, and the box never hands your side a
key that could forge one. That split — and the symmetric-key design it
replaced, and how the hole was found — is [ADR 53](decisions.md#adr-53-ai-launch-tokens-are-asymmetric-event-signatures-stay-symmetric).

## Section 2. The launch token

The launch token is a JWT: three base64url segments, header, claims,
signature, exactly as usual. Two things about it are non-standard enough to
call out before the claims table:

- It is signed **EdDSA over Ed25519** (`RFC 8032`/`RFC 8037`), not the HMAC
  you may be used to from a typical "shared-secret JWT." The header is
  exactly:

  ```json
  { "alg": "EdDSA", "typ": "JWT", "kid": "<16-char base64url thumbprint>" }
  ```

  `kid` is a label — a truncated SHA-256 thumbprint of the public key,
  stable for the life of one keypair and different after a rotation. Your
  verifier MUST NOT use it to choose a key; the box publishes exactly one
  launch public key, and trusting a token-supplied identifier to select
  which key checks it is the exact confusion this design avoids. Your
  verifier also MUST NOT read the header's `alg` to decide how to verify —
  hard-code Ed25519/EdDSA on your side. See §3.
- It is scoped to **one challenge**. The `aud` claim is that challenge's id,
  and a token minted for challenge A will fail verification against
  challenge B. Always pass the challenge id you expect as the audience.

The claims:

| Claim | Type | Meaning |
|---|---|---|
| `iss` | string | Issuer — the box's configured origin (`BETTER_AUTH_URL` normalized to origin form; never derived from a request's `Host` header). Not itself validated server-side, so pin `issuer:` in your verify call if you want that check on your side. |
| `sub` | string | The player's login. This is the identity your event POST asserts a solve for. |
| `aud` | string | The challenge id this token is scoped to. |
| `iat` | number | Issued-at, Unix seconds. |
| `exp` | number | Expiry, Unix seconds. Minted with a 24-hour TTL (`AI_TOKEN_TTL_SEC`). |
| `jti` | string | A unique id for this token, reused as the event route's replay nonce. |
| `ctf.module` | `"ai"` | Always this literal. |
| `ctf.challenge` | `{id, title, points}` | The challenge this token launches. |
| `ctf.points` | number | Same as `ctf.challenge.points` — kept at both levels for convenience. |
| `ctf.progress` | array | The player's progress across the whole `ai` board at mint time — see below. |
| `ctf.truncated` | `true` \| absent | Present only when `ctf.progress` was cut short (see below). |

Each entry in `ctf.progress` is `{id, points, solved, solvedAt}` — one per
`ai` challenge, `solved: false` / `solvedAt: null` for anything the player
hasn't cleared yet. It is a **snapshot taken at mint time**: a fresh token
is minted on every render of `/ai/<id>`, but a session that outlives the
page load should re-read `GET /api/ai/state` (§4) instead of trusting a
stale copy.

The array is capped at 50 entries (`AI_PROGRESS_MAX`) — the token rides
inside a URL, and an event with hundreds of `ai` challenges would otherwise
mint a link long enough for a browser to refuse. When the real list is
longer, solved challenges are moved to the front before the list is cut at
50 — so a truncated token never drops a solve the player already has (up to
50 solves), only unsolved rows — and `ctf.truncated: true` is set; a
truncated token is a completely normal token, not an error, and your site
should treat the flag purely as "there's more — call `/api/ai/state` if you
need the rest."

## Section 3. Verifying it

Fetch the public key once and cache it:

```
GET /api/ai/launch-key
```

```json
{ "alg": "Ed25519", "kid": "b7f3a9c2d1e08f4a", "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n" }
```

Two things to notice about this response. First, its `alg` field says
`"Ed25519"` — that names the **key type** (an EdDSA JWK/JWKS convention),
which is a different string from the JWT header's own `alg: "EdDSA"` (the
**JWS algorithm** name, RFC 8037). Don't feed one where the other is
expected; a library asking "which JWS algorithm" wants `"EdDSA"`
regardless of what this endpoint's `alg` field says. Second, the response
carries `Cache-Control: public, max-age=300` — cache it for about five
minutes, and always re-fetch on a verification failure (a `kid` mismatch
against your cache, or a signature that suddenly stops checking out) and
after any event reset, because a master reset rotates this keypair (§9).

Two verified, ready-to-adapt snippets, keyed to the actual header above:

**JavaScript (`jose`):**

```js
import { importSPKI, jwtVerify } from "jose";

const { publicKey } = await fetch(`${boxOrigin}/api/ai/launch-key`).then((r) => r.json());
// jose's own algorithm name is "EdDSA", not the launch-key response's "Ed25519".
const key = await importSPKI(publicKey, "EdDSA");

const { payload } = await jwtVerify(token, key, { audience: challengeId });
// payload.sub is the player; payload.ctf.challenge / .progress as documented above.
```

**Python (`PyJWT`, needs the `cryptography` extra — `pip install "pyjwt[crypto]"`):**

```python
import requests
import jwt

resp = requests.get(f"{box_origin}/api/ai/launch-key").json()
public_key_pem = resp["publicKey"]

claims = jwt.decode(
    token,
    public_key_pem,
    algorithms=["EdDSA"],
    audience=challenge_id,
)
# claims["sub"] is the player; claims["ctf"]["challenge"] / ["progress"] as documented above.
```

Both libraries want the JWS algorithm name `EdDSA`, never the launch-key
response's own `"Ed25519"` label. An expired token raises/rejects inside
the verify call the same way any other bad signature does — from your
side there's no way to tell "expired" from "forged" without decoding the
claims yourself first, which is exactly why you shouldn't: treat any
verification failure as "not a valid launch," full stop.

## Section 4. Live progress

```
GET /api/ai/state?t=<token>
```

(or `Authorization: Bearer <token>` if your stack can set a header instead
of a query string — either works, and the token carries no more exposure in
the query string than it already has riding inside the launch URL itself).

```json
{ "sub": "alice", "points": 400, "progress": [ { "id": "prompt-armor", "points": 400, "solved": true, "solvedAt": "2026-08-31T12:00:00.000Z" } ] }
```

`progress` has the exact same per-entry shape as the token's `ctf.progress`
— write one parser for both. This route is read-only (no nonce is spent, no
attempt is recorded, nothing is written), rate-limited at 120 requests/min
per token subject, and answers `Cache-Control: no-store` — never cache it
yourself.

## Section 5. Reporting a solve

```
POST /api/ai/event
Content-Type: application/json
X-CTF-Timestamp: <unix seconds>
X-CTF-Signature: sha256=<hex HMAC-SHA256>

{"token": "<launch token>", "challengeId": "<id>", "solvedAt": "<ISO 8601, optional>", "dryRun": false, "meta": {...optional, ignored}}
```

`solvedAt` is **advisory only** — the box's own clock decides when the
solve happened, so an external system cannot backdate itself onto a first
blood. A `meta` object is accepted and silently discarded; use it for your
own logging if you like, the box never reads it.

**The signature, exactly.** Compute:

```
signature = hex(HMAC-SHA256(signingKey, "<unix-timestamp>.<raw request body>"))
```

and send it as `X-CTF-Signature: sha256=<that hex string>`, with the same
timestamp (integer seconds since the epoch) in `X-CTF-Timestamp`. The box
accepts a timestamp within **±300 seconds** of its own clock, in *either*
direction — a request from the future is refused exactly like a stale one.

**This has to be the raw bytes.** The signature covers the exact body the
box receives, byte for byte — not a JSON value you happen to hold that
`JSON.stringify`s to something equivalent. Re-serializing the parsed body
before signing (different key order, different whitespace, a trailing
newline your framework adds) produces a signature that fails verification
and looks *exactly* like you used the wrong key. This is the single most
expensive mistake available on this endpoint: if your signature won't
verify, check this before you rotate anything.

Here is the admin panel's own test curl, reproduced verbatim (per
challenge, with your real key substituted for the placeholder and a real
token from a launch link or the panel's "Send test" button in place of
`eyJ…`):

```sh
KEY='aik_demo0000000000000000000000000000000000000='; TOKEN='eyJ…'
TS=$(date +%s)
BODY='{"token":"'"$TOKEN"'","challengeId":"prompt-armor","solvedAt":"2026-08-31T12:00:00Z","dryRun":true}'
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$KEY" -hex | awk '{print $NF}')
curl -sS -X POST https://your-event.example/api/ai/event \
  -H 'content-type: application/json' \
  -H "X-CTF-Timestamp: $TS" -H "X-CTF-Signature: sha256=$SIG" \
  -d "$BODY"
```

`KEY` above is an obviously-fake demo value — copy your challenge's real
key from the admin panel's Reveal control, never from anywhere in this
document.

**Replay.** Each token's `jti` can drive exactly one *successful* event.
Reuse — replaying a captured request, or your own backend retrying blindly
— gets `409 {"error":"replay"}`. If your request reaches the box but the
solve doesn't land for any other reason, the `jti` stays usable: a teamless
refusal is checked before the nonce is ever claimed, and a pause or store
hiccup after the claim releases it — so a legitimate retry with the same
token still works. Only a request that actually resulted in an award (fresh
or already-awarded) keeps its `jti` spent.

## Section 6. The dry-run workflow

Set `"dryRun": true` and the box runs the entire pipeline — signature,
token, rate limit, team check, pause/schedule gate — and writes no solve,
points, or nonce state: nothing is banked and no `jti` is burned. The one
thing it does spend is the per-login rate-limit budget itself — that check
runs before the dry-run branch, same as a real request — so a dry run is
safe to run against a live event but is not entirely free, and a `503` can
still follow after that budget is charged. The admin panel's "Send test"
button does exactly this, server-side, with a token it mints for itself.

```json
{ "dryRun": true, "wouldAward": true, "verdict": "would-award", "checks": ["body", "challenge", "mode", "signature", "timestamp", "token", "rate-limit", "team", "schedule"] }
```

`wouldAward` is the one field worth branching on. `verdict` names the
outcome (`"would-award"`, `"would-refuse"`, or one of the refusal reasons
from §7 when the request never gets that far). `checks` is **not** a
per-item pass/fail breakdown — it's the fixed, static list of gates the
pipeline evaluates on the way to any dry-run answer; every one of them has
already been checked (and the ones before it passed, or you'd have gotten
that gate's own error response instead of a `dryRun` body at all) by the
time you see it.

## Section 7. The full error table

Every response from every `ai` route — success or refusal — carries CORS
headers, so a browser-side integrator can always read the status, not just
a same-origin backend. A refusal is never a bare 500: an unreachable
datastore surfaces as `503 {"error":"unavailable"}` rather than a
connection your `fetch` can't even inspect.

| Status | Body | Meaning | Routes | What to do |
|---|---|---|---|---|
| 200 | `{"correct": true, "points": N, "already": false}` | Fresh solve recorded. | submit, event | Done. |
| 200 | `{"correct": true, "points": 0, "already": true}` | The solve was already on record — this call banked nothing further. In practice you will rarely see this: a repeat submission is normally caught earlier as `409 solved` (below); this only appears on a genuine race between two near-simultaneous requests for the same player/challenge. | submit, event | Nothing to do; treat as success. |
| 200 | `{"correct": false}` | Wrong flag. | submit | Let the player try again (subject to cooldown). |
| 200 | `{"dryRun": true, "wouldAward": bool, "verdict": ..., "checks": [...]}` | Dry-run result (§6). | event | Inspect `wouldAward`. |
| 400 | `{"error": "invalid-request"}` | Malformed/oversized JSON body, missing `token`, a `challengeId` that isn't a valid id, a non-boolean `dryRun`, or (submit only) a missing/empty/over-length flag. Body is capped at 8192 bytes, checked while reading — never fully buffered past the cap. | submit, event | Fix the request shape; this is a client bug, not worth retrying as-is. |
| 400 | `{"error": "invalid"}` | The grading store's own refusal of the same class: the id or flag failed its validation after the route's checks passed, or the challenge vanished between the route's lookup and the grading script. Rare — the route normally catches these first as `invalid-request`/`unknown-challenge`. | submit, event | Treat exactly like `invalid-request`; if it persists, the challenge was probably just deleted. |
| 401 | `{"error": "invalid-signature"}` | The `X-CTF-Signature` HMAC doesn't check out against your challenge's key and the raw body. | event | Almost always a re-serialized body (§5) or a stale/rotated key — check both before assuming the key is wrong. |
| 401 | `{"error": "stale-request"}` | `X-CTF-Timestamp` missing/non-numeric, or outside the ±300s window. | event | Resync your clock; retry with a fresh timestamp and matching signature. |
| 401 | `{"error": "invalid-token"}` | The launch token is malformed, its signature doesn't verify, or its `aud` doesn't match the challenge id. | submit, event, state | The token is unusable — the player needs a fresh launch link. |
| 401 | `{"error": "expired"}` | The launch token's `exp` has passed (>24h since mint). | submit, event, state | Same as above — a fresh launch link, not a retry. |
| 403 | `{"error": "paused"}` | The event is frozen or outside its scheduled scoring window. | submit, event | Retry later; this isn't an error in your integration. |
| 403 | `{"error": "no-team"}` | The player isn't on a team. | submit, event | Nothing to do on your side — team membership is the player's problem to fix in the box's UI. |
| 404 | `{"error": "unknown-challenge"}` | The `challengeId` (or the token's `aud`) doesn't name a live challenge. | submit, event | Check the id you're using; it may have been deleted or never existed. |
| 409 | `{"error": "wrong-mode"}` | You asserted an event against a `mode: "flag"` challenge, or submitted a flag against a `mode: "event"` one. | submit, event | Use the other reporting path — see §1/§8. |
| 409 | `{"error": "solved"}` | This player has already solved this challenge. This is the *normal* shape of "already solved," distinct from the rare 200/`already:true` race noted above. | submit, event | Nothing to do; the player is credited. |
| 409 | `{"error": "replay"}` | This token's `jti` already produced a solve. | event | Don't retry with the same token; if the earlier attempt genuinely failed, the nonce was released (§5) so a fresh attempt with the same token works. |
| 429 | `{"error": "cooldown", "retryAt": "<ISO 8601>"}` | Submitting flags too fast against this challenge (graded/flag path only — an event has no wrong answer to rate-limit this way). | submit | Wait until `retryAt`. |
| 429 | `{"error": "rate-limited"}`, `Retry-After: <seconds>` header | The route's own per-player request budget (currently 60/min for submit and event, 120/min for state) was exceeded — a different limiter from the cooldown above. | submit, event, state | Back off for `Retry-After` seconds. |
| 503 | `{"error": "unavailable"}` | The box's datastore couldn't answer this request at all. | submit, event, state, launch-key | Safe to retry with backoff — nothing was written. |
| 503 | `{"error": "error"}` | The grading step itself failed or returned something the box didn't recognize — distinct from `unavailable` but the same 503 and the same "nothing was written, retry" advice. | submit, event | Safe to retry with backoff. |

`GET /api/ai/launch-key` and `GET /api/ai/state` never return `wrong-mode`,
`replay`, `cooldown`, `no-team`, `solved`, `paused`, `invalid-request`, or
`invalid-signature` — they don't write anything and don't gate on team,
pause, or mode, so those reasons don't apply. `launch-key` in particular
answers either `200` or `503 unavailable`; nothing else.

No response from any of these contestant-facing routes carries a flag or a
signing key — the result types this table is drawn from simply have no
field for either. That's a statement about `submit`/`event`/`state`/
`launch-key`, not about the box as a whole: the admin panel's Reveal
control deliberately shows a challenge's signing key to an organizer (see
docs/operations.md), which is a different, authenticated surface than
anything in this table.

## Section 8. Flag submission

```
POST /api/ai/submit
Content-Type: application/json

{"token": "<launch token>", "flag": "<what the player typed>"}
```

For external sites that render their own flag box rather than (or in
addition to) reporting solves as events. Grading has the same forgiveness
rules as the box's built-in `classic` module: flags compare case-insensitive
unless the challenge is authored case-sensitive, and a correct/incorrect
answer both count as an "attempt" toward the graded-path cooldown.

The box's own in-page form for this same challenge, when the organizer
enables it, does **not** call this route — it grades through a server
action, and the launch token never reaches the contestant's browser at all
in that path. `/api/ai/submit` exists specifically for *your* site to call
on the player's behalf, when you're the one rendering the flag input.

## Section 9. Keys and rotation

Two independent keys, and they rotate on different triggers:

- **Your per-challenge signing key** (`aik_…`), used for the HMAC in §5.
  Visible in the admin panel's per-challenge integration tab (masked by
  default; Reveal and Copy controls). Rotating it takes effect
  **immediately, with no grace window** — the moment an organizer clicks
  Rotate, your old key stops verifying, and your backend needs the new one
  before its next event POST. There is no overlap period to redeploy
  during. The key travels in the box's whole-event archive, so a board
  restored from an export keeps the key you configured against.
- **The module-wide launch keypair.** One Ed25519 pair for the whole `ai`
  module (not one per challenge — `aud` already scopes a token to a single
  challenge). The public half is what `GET /api/ai/launch-key` serves; the
  private half never leaves the box and is what actually mints tokens. It
  is minted lazily on first use and otherwise stable — the one thing that
  rotates it is a **master event reset**, which deletes the stored keypair
  outright. An archive import does NOT: the keypair is not part of a bundle,
  and the import leaves the box's own pair in place. The next launch mints a fresh pair, every previously-issued
  launch token stops verifying, and your cached public key (§3) becomes
  stale — re-fetch it after any reset, or plan to react to a sudden run of
  `invalid-token` refusals by doing so.

## Section 10. v1 gaps

Honestly, as shipped:

- **No dual-key window during signing-key rotation.** Because rotation is
  immediate (§9), there's no way to roll your backend to a new key without
  a gap in which either the old key still verifies briefly or your posts
  fail until redeployed.
  ([#251](https://github.com/OWASP/owasp-ctf-in-a-box/issues/251))
- **No per-challenge attempt cap.** The graded (flag) path only throttles
  with the cooldown in §7/§8 — there is no ceiling on total attempts, only
  on how fast they can come in.
  ([#252](https://github.com/OWASP/owasp-ctf-in-a-box/issues/252))
