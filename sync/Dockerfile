FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# su-exec is what the entrypoint drops privileges with; the busybox setpriv in
# this base has no --reuid. Pinned to the version in the base image's Alpine
# release (the base is pinned by digest above, so this is deterministic too).
RUN apk add --no-cache su-exec=0.3-r0 \
  && mkdir -p /state && chown node:node /state \
  && chmod 0755 /usr/local/bin/docker-entrypoint.sh
# No `USER node` here on purpose: the entrypoint starts as root so it can
# create and chown dirname(STATE_PATH) — on Fly that is a directory on a
# root-owned volume — and then drops to node itself before exec'ing CMD. The
# process that polls GitHub still runs as uid 1000.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
