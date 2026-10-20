import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForVAmPI, vampiFetch, getToken, createDb } from '../helpers.js';

await createDb();
await waitForVAmPI();

// Pass-on-patch: drives the exploit (name1 resets name2's password with only name1's token) and
// asserts it is BLOCKED. On the vulnerable app name2's password is hijacked, so this FAILS; once the
// handler authorizes the password change to the token's own user, name2's password is unchanged and
// the attacker-set password does NOT work -> PASSES.
await test('Challenge-6-Unauthorized-Password-Change', async () => {
  // Anti-vacuous precondition: the victim must exist before the exploit is
  // tried. /createdb commits name1, name2 and admin one at a time, and in the
  // gap the stock app answers the PUT below with 400 "User Not Found", so the
  // login assertion would pass with no fix in place (#661). getToken retries,
  // which also rides out that gap on a real box.
  await getToken('name2', 'pass2');
  const name1Token = await getToken('name1', 'pass1');
  const newPassword = `hacked_${Date.now()}`;

  await vampiFetch('/users/v1/name2/password', {
    method: 'PUT',
    token: name1Token,
    body: { password: newPassword },
  });

  // VULNERABLE: name2 can now log in with the attacker-set password.
  const login = await vampiFetch('/users/v1/login', {
    method: 'POST',
    body: { username: 'name2', password: newPassword },
  });
  assert.ok(!(login.status === 200 && login.json?.auth_token),
    'unauthorized password change must be blocked: name2 must not be loginable with an attacker-set password');
});
