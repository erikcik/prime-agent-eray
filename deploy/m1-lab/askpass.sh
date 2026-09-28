#!/bin/bash
# SSH_ASKPASS helper: asks for the M1 login password in a macOS dialog, so key installation works
# from a non-interactive shell. Used once by `m1-lab.sh connect`; the password is never stored.
prompt="${1:-Password for the M1 lab Mac}"
prompt="${prompt//\"/\\\"}"
# `activate` first: from a background process the dialog otherwise opens behind other windows.
exec osascript \
	-e 'activate' \
	-e "display dialog \"$prompt\" with title \"M1 lab: install SSH key\" default answer \"\" with hidden answer buttons {\"Cancel\", \"OK\"} default button \"OK\"" \
	-e 'text returned of result'
