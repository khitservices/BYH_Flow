#!/usr/bin/env bash
# scripts/init-env.sh — create .env, or fill in whatever an existing .env is missing. Run on the server,
# from the repo folder, before `docker compose up`. Safe to run again: it never changes a value that is
# already set, and it never prints a secret.
#   ./scripts/init-env.sh https://practice.example.co.uk
set -euo pipefail
cd "$(dirname "$0")/.."
command -v openssl >/dev/null || { echo "openssl is needed"; exit 1; }
umask 077
[ -f .env ] || { cp .env.example .env; echo "created .env"; }
chmod 600 .env

current() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' || true; }
put() { # put KEY VALUE
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
fill() { # fill KEY VALUE: only when unset or still the placeholder
  local v; v="$(current "$1")"
  if [ -z "$v" ] || [ "$v" = "change-me" ]; then put "$1" "$2"; echo "generated $1"; else echo "kept $1"; fi
}

if [ "${1:-}" != "" ]; then
  case "$1" in https://*) put BASE_URL "${1%/}"; echo "set BASE_URL";; *) echo "the address must start with https://"; exit 1;; esac
fi
had_file_key="$(current FILE_ENCRYPTION_KEY)"
fill POSTGRES_PASSWORD   "$(openssl rand -hex 24)"
fill SESSION_SECRET      "$(openssl rand -hex 32)"
fill SECRETS_KEY         "$(openssl rand -base64 32)"
fill FILE_ENCRYPTION_KEY "$(openssl rand -base64 32)"

echo
echo "Done. Address: $(current BASE_URL)"
if [ -z "$had_file_key" ]; then
  echo "IMPORTANT: a new FILE_ENCRYPTION_KEY was created. Copy that line from .env to somewhere away from"
  echo "this server and its backups (a password manager). Without it, stored documents cannot be read."
fi
echo "Next: docker compose up -d --build"
