#!/usr/bin/env bash
# The root `npm run build`, minus packages/ai's `generate-models` step: compiles against the
# committed packages/ai/src/models.generated.ts instead of live provider catalogs.
#
# Why: generate-models fetches models.dev and friends at build time, so a deploy build breaks
# whenever a catalog changes shape upstream (2026-09-28: models.dev renamed `kimi-for-coding`,
# `KnownProvider` still lists `kimi-coding`, tsgo fails with TS2536). A pod should build the
# catalog that was tested, not whatever the internet serves that minute. Regenerate on a dev
# machine and commit when the catalog should move.
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"
(cd packages/tui && npm run build)
(cd packages/ai && npx tsgo -p tsconfig.build.json)
(cd packages/agent && npm run build)
(cd packages/coding-agent && npm run build)
