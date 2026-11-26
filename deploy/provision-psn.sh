#!/usr/bin/env bash
# Run interactively on Sydney. Input never appears in the terminal or command arguments.
set -euo pipefail
read -rsp 'Paste the PlayStation NPSSO and press Enter: ' leonida_npsso
printf '\n'
if [[ ! "$leonida_npsso" =~ ^[a-zA-Z0-9._~-]{32,256}$ ]]; then
    printf 'Unexpected NPSSO format.\n' >&2
    exit 1
fi
printf '%s' "$leonida_npsso" | sudo -u leonida /bin/sh -c '
    set -eu
    umask 077
    staged=$(mktemp /var/lib/leonida/.psn-bootstrap.XXXXXX)
    trap "rm -f -- \"$staged\"" EXIT
    cat > "$staged"
    mv -f -- "$staged" /var/lib/leonida/psn-bootstrap
'
unset leonida_npsso
printf 'Credential saved. Open Leonida AI and choose Sync now.\n'
