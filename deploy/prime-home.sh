#!/usr/bin/env bash
# Pod-side target of the Mac `prime` command (deploy/prime). Loads the agent env the entrypoint
# wrote for ssh logins, then runs the harness TUI in the agents' working directory.
#
#   prime-home.sh              agents view: every live session, attach / new from there
#   prime-home.sh new [args]   a new interactive session
#   prime-home.sh <args>       any other prime-agent command (list, attach <agent>, send, ...)
set -eo pipefail

if [[ -r "$HOME/.prime-env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.prime-env"
else
  echo "prime: $HOME/.prime-env is missing; this pod's image predates it (needs 0.1.3+)" >&2
  exit 1
fi

cd "${DEPLOY_PROJECT_DIR:-/workspace/project}"

case "${1:-}" in
  "") exec prime-agent agents ;;
  new) shift; exec prime-agent "$@" ;;
  __shell__) exec bash -i ;;
  *) exec prime-agent "$@" ;;
esac
