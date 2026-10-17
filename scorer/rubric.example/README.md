# Example rubric

This directory is the **declarative-grammar tutorial** — `juice-shop.yaml` is
commented as a step-by-step guide to writing HTTP request/expect probes. Read it
first if you are authoring your own rubric from scratch.

It is no longer what a stock build bakes. Three rubric directories now live
under `scorer/`:

| Directory | What it is | Baked by default |
|---|---|---|
| `rubric.owasp/` | The vendored six-target rubric — executable `node:test` suites covering all 321 challenges | yes |
| `rubric.example/` | This tutorial: one target, three declarative YAML probes | no (`--build-arg RUBRIC_DIR=rubric.example`) |
| `rubric/` | Your own private rubric — gitignored, never committed | no (`--build-arg RUBRIC_DIR=rubric`) |

Both rubric shapes are supported by the engine simultaneously, and a single
rubric directory may mix them: `<target>.yaml` files use the declarative probe
grammar, `<target>/tests/challenges/` directories use executable tests priced by
`catalogue.<target>.json`.

The targets are open source and their solutions are already public, so a rubric
is not a secret. Keeping *your* rubric private during an event is about
**scoring integrity**, not hiding answers: it stops a contestant from crafting a
patch that satisfies the exact probe string without actually fixing the vuln.

## Author your own rubric

1. Copy this directory somewhere outside the repo (or straight into
   `scorer/rubric/`, which is gitignored — see the build command below):

   ```sh
   cp -r scorer/rubric.example ./my-rubric
   ```

2. **One file per target**, named `<target>.yaml`. The `target:` field inside
   the file MUST match the filename stem, and both must match the target id used
   by the event — the Secure Development target list in `/admin`, and the
   consumer workflow's `TARGET`. Example:
   `juice-shop.yaml` with `target: juice-shop`.

3. Write honest, declarative probes that **assert the fix, not the exploit** —
   the tutorial comments in `juice-shop.yaml` cover the grammar, points, id
   charset, and what makes a good check.

## Build your private scorer image

`COPY` can only read paths *inside* the Docker build context, and the context is
`scorer/`. A rubric outside the repo therefore cannot be referenced with
`../my-rubric`. Place your rubric at `scorer/rubric/` (gitignored) and point
`RUBRIC_DIR` at it:

```sh
cp -r ./my-rubric scorer/rubric
docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
  -t ghcr.io/<org>/score:latest --build-arg RUBRIC_DIR=rubric scorer/
```

GitHub runners need a `linux/amd64` image (`setup/ctf-setup.sh` refuses to
mirror anything else), and turning attestations off keeps it one plain
manifest rather than an index, which the Fly deploy's registry mirror needs.

(Add `--build-arg RUBRIC_DIR=rubric.example` to bake this tutorial rubric instead.)

## Keep it private during the event, publish it after

Keep the built image **private** (`ghcr.io/<org>/score` package = private) while
the event runs — see `setup/ctf-setup.sh org` for the mirror + access steps.
Once the event is over, you are encouraged to **publish your rubric** as
teaching material: this is an educational CTF and the solutions are public
anyway. A well-written rubric is a great artifact for the next cohort.
