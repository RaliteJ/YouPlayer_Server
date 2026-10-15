#!/usr/bin/env bash
set -euo pipefail
umask 077

installer_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
command -v node >/dev/null || { echo 'Installer Node.js >= 22.12 avant de continuer.' >&2; exit 1; }
node "$installer_dir/scripts/install.mjs" check

if [[ -e "$installer_dir/.env" ]]; then
  exec node "$installer_dir/scripts/install.mjs" install
fi

[[ -t 0 ]] || { echo 'Lancer ./install.sh dans un terminal interactif.' >&2; exit 1; }
read -r -p 'Pseudo du compte administrateur : ' installer_pseudo
read -r -s -p 'Mot de passe admin (12 caractères minimum, sans apostrophe ni antislash) : ' installer_password
printf '\n'
read -r -s -p 'Confirmer le mot de passe : ' installer_confirmation
printf '\n'
[[ "$installer_password" == "$installer_confirmation" ]] || { echo 'Les mots de passe diffèrent.' >&2; exit 1; }

printf '%s\0%s' "$installer_pseudo" "$installer_password" | node "$installer_dir/scripts/install.mjs" install
