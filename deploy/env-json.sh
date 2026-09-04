#!/usr/bin/env bash
# Render deploy/.env into a JSON object of pod env vars, for deploy/runpod-deploy.py.
# Values are never printed: they go straight from the sourced shell into the output file,
# which is created 0600 and should be deleted after the deploy.
#
#   deploy/env-json.sh [out.json]        # default: a 0600 temp file, path echoed on stdout
#
# Only the keys the pod actually needs are exported; empty ones are dropped (the entrypoint
# treats a missing ANTHROPIC_OAUTH_TOKEN as "no anthropic provider").
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
envfile="${DEPLOY_ENV_FILE:-$here/.env}"
[[ -f "$envfile" ]] || { echo "no $envfile (copy .env.example and fill it)" >&2; exit 2; }

out="${1:-}"
if [[ -z "$out" ]]; then
  out="$(mktemp -t prime-agent-podenv)"
fi
: >"$out"; chmod 600 "$out"

set -a; . "$envfile"; set +a

KEYS=(PRIME_OBSERVER_TOKEN NANO_GPT_API_KEY ANTHROPIC_OAUTH_TOKEN SERPER_API_KEY
      DEPLOY_GIT_SSH_KEY DEPLOY_REPO_URL DEPLOY_REPO_BRANCH PUBLIC_KEY
      PRIME_OBSERVER_ALLOWED_ORIGINS DEPLOY_DEFAULT_PROVIDER DEPLOY_DEFAULT_MODEL)

KEYS="${KEYS[*]}" OUT="$out" python3 - <<'PY'
import json, os
keys = os.environ["KEYS"].split()
env = {k: os.environ[k] for k in keys if os.environ.get(k, "").strip()}
with open(os.environ["OUT"], "w") as fh:
    json.dump(env, fh, indent=1)
# Report only key names and lengths — never values.
for k in keys:
    v = os.environ.get(k, "")
    print(f"  {k:<32} {'set (' + str(len(v)) + ' chars)' if v.strip() else '— empty, omitted'}")
PY

echo "$out"
