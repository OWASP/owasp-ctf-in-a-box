# Juice Shop challenge tests

Each test in `challenges/` exercises **one** Juice Shop vulnerability. It
**fails** while the exploit still works and **passes** once a patch closes the
hole.

## How the judge runs them

The scorer image bakes this rubric. On each contestant pull request, the
consumer workflow
([`scorer/consumer-workflow.example.yml`](https://github.com/OWASP/owasp-ctf-in-a-box/blob/main/scorer/consumer-workflow.example.yml))
runs the judge (`scorer/src/judge.js`), which builds the PR's code, boots it
as a sibling container, and runs every challenge listed in
[`challenges/catalogue.juice-shop.json`](challenges/catalogue.juice-shop.json)
as its own `node --test` child process (`scorer/src/exec.js`). A challenge
scores its catalogue `difficulty` in points when its file passes.

The children get the app's URL in `JUICE_SHOP_URL`. The static
source-analysis challenges (9, 12 and 16) read TypeScript instead of probing
HTTP; the judge points `CTF_UPSTREAM_DIR` at the PR checkout for them.

## Files

- `challenges/Challenge-<N>-<Title>.test.js` — one challenge. Its catalogue
  entry's `key` is the file name without `.test.js`, and `file` names it.
- `challenges/*.guard.test.js` — tests of a scorer helper, not challenges;
  the catalogue does not list them, so the judge never runs them.
- `challenges/lib/` and `helpers.js` — shared helpers (`api()`,
  `registerAndLogin()`, `waitForServer()`, `assertShopAlive()`).

## Run locally

Boot the pinned version the way the judge does (`NODE_ENV=unsafe` turns off
Juice Shop's safety mode, so every challenge is live):

```sh
docker run --rm -p 3000:3000 -e NODE_ENV=unsafe bkimminich/juice-shop:v20.0.0
```

For the static challenges, point `CTF_UPSTREAM_DIR` at a Juice Shop source
tree at the same version (your patched checkout, or a stock clone):

```sh
export CTF_UPSTREAM_DIR=/path/to/juice-shop
```

Then, from `scorer/rubric.owasp/juice-shop/tests/`:

```sh
# exactly the challenges the judge runs (the catalogue's files, no guards)
node --test $(node -p 'require("./challenges/catalogue.juice-shop.json").map((c) => "challenges/" + c.file).join(" ")')

node --test challenges/Challenge-1-Password-Hash-Leak.test.js   # one
node --test challenges/                                         # everything, guards included
```

Set `JUICE_SHOP_URL` to test another host. Against the stock image every
challenge in the first command should fail: a stock app scores 0..

## Adding a challenge

1. Create `challenges/Challenge-<N>-<Title>.test.js` with
   [`node:test`](https://nodejs.org/api/test.html) — no runner dependency.
2. Add its entry to `catalogue.juice-shop.json` (`key`, `id`, `file`,
   `name`, `difficulty`, `owasp`, `category`); the judge runs only what the
   catalogue lists.
3. Make it fail against the stock app and pass against a fix. Before
   asserting the fix, call `assertShopAlive()` (a health check: the app is up
   and its catalogue answers) and then prove this challenge's own exploit
   path is reachable, so neither a down app nor a missing route can pass it.
