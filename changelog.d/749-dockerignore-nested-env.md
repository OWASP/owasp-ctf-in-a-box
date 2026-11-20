- **Security: the app image no longer picks up nested `.env` files (#749).**
  The app build reads `apps/web/Dockerfile.dockerignore`, whose rules matched
  only the repo root, so `apps/web/.env.local` was copied into the image. Both
  ignore files now exclude `.env`, `.env.*`, `node_modules` and `.next` at any
  depth, which also keeps a host-built `node_modules` out of the build.
