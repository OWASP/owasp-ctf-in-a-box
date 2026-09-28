.POSIX:

.PHONY: help registries test-sync test-scorer lint-app test-app lint-shell \
	test-shell smoke acceptance-scorer acceptance-quiz-only \
	acceptance-classic-only acceptance-ai-only dev-up dev-down

# Thin wrappers around the commands in AGENTS.md — that file is the
# authority on what CI runs; this just saves retyping the `cd`s. Pick the
# area you touched. There is deliberately no full-repo `test` target: CI's
# `changes` job path-filters per area, and one target that runs everything
# would undo that discipline locally.
help:
	@echo "Targets (pick the area you touched; AGENTS.md is the authority):"
	@echo "  registries            target lists must agree; no Docker"
	@echo "  test-sync             sync unit tests"
	@echo "  test-scorer           scorer unit tests, vacuous-pass gate, offline acceptance loop"
	@echo "  lint-app              app: install + eslint"
	@echo "  test-app              app: install + eslint + vitest"
	@echo "  lint-shell            shellcheck over scripts/, setup/, entrypoints, deploy/fly"
	@echo "  test-shell            bats over setup/test/, deploy/fly/test/, scripts/test/"
	@echo "  smoke                 the full poll pipeline, end to end, offline"
	@echo "  acceptance-scorer     scorer's offline acceptance loop"
	@echo "  acceptance-quiz-only  quiz-only compose bring-up"
	@echo "  acceptance-classic-only  classic-only compose bring-up"
	@echo "  acceptance-ai-only    ai-only compose bring-up"
	@echo "  dev-up                local dev-stack up (throwaway secrets, seeded demo board)"
	@echo "  dev-down              local dev-stack down"
	@echo ""
	@echo "Not wrapped here: the app's live Lua/upstash suite (needs a real"
	@echo "redis + srh — see AGENTS.md) and the two real-target scoring gates,"
	@echo "./scripts/acceptance-target.sh and ./scripts/acceptance-patched.sh"
	@echo "(Docker, pulls upstream images, minutes per row — see AGENTS.md)."

registries:
	node scripts/check-module-registries.mjs

test-sync:
	cd sync && npm ci && npm test

test-scorer:
	(cd scorer && npm ci && npm test) && (cd scorer && node tools/vacuous-sweep.mjs) && ./scripts/acceptance-scorer.sh

lint-app:
	cd apps/web && corepack enable && corepack pnpm install --frozen-lockfile && corepack pnpm lint

test-app:
	cd apps/web && corepack enable && corepack pnpm install --frozen-lockfile && corepack pnpm lint && corepack pnpm test

lint-shell:
	shellcheck scripts/*.sh scripts/lib/*.sh scripts/dev-stack setup/*.sh scorer/entrypoint.sh sync/docker-entrypoint.sh \
	  deploy/fly/deploy.sh deploy/fly/render-compose.sh
	shellcheck -s sh --exclude=SC2034 scorer/entrypoints/*.sh

test-shell:
	bats setup/test/ && bats deploy/fly/test/ && bats scripts/test/

smoke:
	./scripts/smoke.sh

acceptance-scorer:
	./scripts/acceptance-scorer.sh

acceptance-quiz-only:
	./scripts/acceptance-quiz-only.sh

acceptance-classic-only:
	./scripts/acceptance-classic-only.sh

acceptance-ai-only:
	./scripts/acceptance-ai-only.sh

dev-up:
	./scripts/dev-stack up

dev-down:
	./scripts/dev-stack down
