#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
fail() { echo "$*" >&2; exit 1; }

installer_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
command -v node >/dev/null || { echo 'Installer Node.js >= 22.12 avant de continuer.' >&2; exit 1; }
installer_engine=${1:-podman}
node "$installer_dir/scripts/install-release.mjs" check "$installer_engine"

if [[ -e "$installer_dir/.env" ]]; then
  exec node "$installer_dir/scripts/install-release.mjs" install "$installer_engine"
fi
[[ -f .env && ! -L .env ]] || fail '.env doit être un fichier régulier, sans lien symbolique.'
[[ $(stat -c %a .env) == 600 ]] || fail 'Protéger .env avec chmod 600 .env.'

# Lire les valeurs littéralement : aucun code exécuté, aucun $ réinterprété.
for key in ${!YOUPLAYER_@} ${!COMPOSE_@}; do unset "$key"; done
shopt -s extglob
while IFS= read -r line || [[ -n $line ]]; do
  line=${line%$'\r'}
  line=${line##+([[:space:]])}; line=${line%%+([[:space:]])}
  [[ -z $line || $line == \#* ]] && continue
  [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || fail 'Ligne .env invalide.'
  key=${BASH_REMATCH[1]}; value=${BASH_REMATCH[2]}
  value=${value##+([[:space:]])}; value=${value%%+([[:space:]])}
  if [[ $value == \"*\" || $value == \'*\' ]]; then value=${value:1:${#value}-2}; fi
  [[ $key == YOUPLAYER_* || $key == COMPOSE_PROJECT_NAME ]] && export "$key=$value"
done < .env
[[ ${COMPOSE_PROJECT_NAME:-youplayer-server} == youplayer-server ]] || fail 'Nom de projet .env différent : consulter UPDATES.md.'
: "${YOUPLAYER_ADMIN_PASSWORD:=}" "${YOUPLAYER_SESSION_SECRET:=}" "${YOUPLAYER_SPOTIFY_TOKEN_SECRET:=}"
[[ -n ${YOUPLAYER_ADMIN_PSEUDO:-} && ${#YOUPLAYER_ADMIN_PASSWORD} -ge 12 ]] || fail 'Compte admin absent ou mot de passe trop court dans .env.'
[[ ${#YOUPLAYER_SESSION_SECRET} -ge 32 && ! ${YOUPLAYER_SESSION_SECRET,,} =~ replace|change|example|local-session|dev-session|^\$\{ ]] || fail 'Secret de session trop faible dans .env.'
if [[ -n ${YOUPLAYER_SPOTIFY_CLIENT_ID:-}${YOUPLAYER_SPOTIFY_CLIENT_SECRET:-}${YOUPLAYER_SPOTIFY_REDIRECT_URI:-} ]]; then
  [[ -n ${YOUPLAYER_SPOTIFY_CLIENT_ID:-} && -n ${YOUPLAYER_SPOTIFY_CLIENT_SECRET:-} && -n ${YOUPLAYER_SPOTIFY_REDIRECT_URI:-} ]] || fail 'Configuration Spotify OAuth incomplète.'
  [[ ${#YOUPLAYER_SPOTIFY_TOKEN_SECRET} -ge 32 && ! ${YOUPLAYER_SPOTIFY_TOKEN_SECRET,,} =~ replace|change|example|^\$\{ ]] || fail 'Secret Spotify trop faible dans .env.'
fi

[[ ! ${YOUPLAYER_ADMIN_PASSWORD,,} =~ replace|change|example|^\$\{ ]] || fail 'Remplacer le mot de passe exemple dans .env.'

printf '%s\0%s' "$installer_pseudo" "$installer_password" | node "$installer_dir/scripts/install-release.mjs" install "$installer_engine"
