import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Vulnerable VAmPI instance. In local docker-compose the vulnerable container
// (vulnerable=1) is published on port 5002; CI publishes it on 5001 via the
// service definition. VAMPI_URL overrides both.
const BASE = process.env.VAMPI_URL ?? 'http://127.0.0.1:5002';

export function baseUrl() {
  return BASE;
}

export async function waitForVAmPI({ timeoutMs = 60_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.status === 200) return;
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`VAmPI did not become healthy within ${timeoutMs}ms — last error: ${lastErr}`);
}

// /createdb does db.drop_all() + db.create_all() + reseed. `node --test`
// launches each test file in its own process in parallel, so naive per-file
// seeding causes concurrent drop/recreate races (queries see an empty DB).
// We coordinate across processes with a lock file keyed to the target URL:
// exactly one process performs the seed; the rest wait for it to finish.
function seedLockPath() {
  // Scope the lock to (target URL + this test invocation). All sibling test
  // files spawned by one `node --test` share the same parent PID, so they
  // coordinate on one seed; a fresh invocation gets a fresh lock and reseeds.
  const key = crypto
    .createHash('sha1')
    .update(`${BASE}:${process.ppid}`)
    .digest('hex')
    .slice(0, 12);
  return path.join(os.tmpdir(), `vampi-seed-${key}.lock`);
}

export async function createDb({ ttlMs = 20_000 } = {}) {
  const lock = seedLockPath();

  // If a recent seed already happened, trust it.
  try {
    const st = fs.statSync(lock);
    const content = fs.readFileSync(lock, 'utf8');
    if (content === 'done' && Date.now() - st.mtimeMs < ttlMs) return;
  } catch { /* no lock yet */ }

  // Try to become the seeder by exclusively creating the lock.
  let owner = false;
  try {
    fs.writeFileSync(lock, 'seeding', { flag: 'wx' });
    owner = true;
  } catch {
    owner = false;
  }

  if (owner) {
    await fetch(`${BASE}/createdb`);
    await waitUntilSeeded();
    fs.writeFileSync(lock, 'done');
    return;
  }

  // Another process owns the seed. Wait for BOTH the lock to report done AND the DB
  // to actually be live — the lock alone can momentarily race a concurrent reseed.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let lockDone = false;
    try { lockDone = fs.readFileSync(lock, 'utf8') === 'done'; } catch { /* lock vanished */ }
    if (lockDone && await isSeeded()) return;
    await new Promise(r => setTimeout(r, 150));
  }
  // Fallback: seed ourselves rather than hang.
  await fetch(`${BASE}/createdb`);
  await waitUntilSeeded();
}

// True once every seeded user is queryable. /createdb commits them one at a
// time (name1, name2, admin), so name1 alone can be present mid-seed.
const SEED_USERS = ['name1', 'name2', 'admin'];

async function isSeeded() {
  try {
    const res = await fetch(`${BASE}/users/v1/_debug`);
    if (res.status !== 200) return false;
    const data = await res.json();
    return Array.isArray(data.users) && SEED_USERS.every(name => data.users.some(u => u.username === name));
  } catch {
    return false;
  }
}

async function waitUntilSeeded({ timeoutMs = 15_000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isSeeded()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// Force a fresh seed regardless of the lock (used by tests that mutate seed data).
export async function resetDb() {
  await fetch(`${BASE}/createdb`);
  try { fs.writeFileSync(seedLockPath(), 'done'); } catch { /* ignore */ }
}

export async function getToken(username = 'name1', password = 'pass1', { retries = 8, delayMs = 300 } = {}) {
  // Test files run in parallel processes and each (re)seeds the shared DB at
  // startup; a login can momentarily race a /createdb reseed. Retry to absorb
  // that window — the vulnerability under test is unaffected.
  let last;
  for (let i = 0; i < retries; i++) {
    const res = await fetch(`${BASE}/users/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (data.auth_token) return data.auth_token;
    last = data;
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`Login failed for ${username} after ${retries} tries: ${JSON.stringify(last)}`);
}

export async function vampiFetch(path, { method = 'GET', token, body, headers = {} } = {}) {
  const url = `${BASE}${path}`;
  const reqHeaders = { 'Content-Type': 'application/json', ...headers };
  if (token) reqHeaders['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

// Forge an HS256 JWT for VAmPI using the known weak SECRET_KEY ('random' by
// default). No external dependency — HS256 is HMAC-SHA256 over the b64url
// header.payload.
export function forgeJwt(sub, { secret = 'random', ttlSeconds = 3600 } = {}) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({ exp: now + ttlSeconds, iat: now, sub });
  const signingInput = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}

// ── anti-vacuous precondition ─────────────────────────────────────────────────

/**
 * Proves the API is genuinely up AND seeded before an "the exploit was blocked"
 * assertion is trusted — see docs/scorer.md, "The vacuous pass", and issue #47.
 *
 * This is the generalisation of the guard already written by hand into
 * Challenge-7-Weak-JWT, which is where the failure was first found: the app was
 * up, a seeding race had left the account missing, and the block assertion
 * passed for entirely the wrong reason on a STOCK target.
 *
 * A legitimate login is the right oracle for this target. It exercises the
 * database and the auth path in one call, and none of the vulnerabilities
 * scored here is "logging in works" — so it holds on the vulnerable app and on
 * a patched one alike. Patching enumeration changes the failure MESSAGE, and
 * patching rate limiting throttles repeated FAILED attempts; neither stops a
 * single valid credential from authenticating.
 */
export async function assertApiAlive(what = 'vampi') {
  let token;
  try {
    token = await getToken('name1', 'pass1');
  } catch (err) {
    throw new Error(
      `anti-vacuous precondition failed: ${what} could not complete a legitimate login ` +
        `(${err.message}). The app is unreachable, unseeded or degraded, so "the exploit ` +
        `was blocked" below would pass for the wrong reason.`,
    );
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`anti-vacuous precondition failed: ${what} returned no auth token for a valid login.`);
  }
}
