#!/usr/bin/env bash
set -euo pipefail
umask 077

debug_step() {
  if [[ ${YOUPLAYER_INSTALL_DEBUG:-0} == 1 ]]; then
    printf '[install] %s\n' "$1" >&2
  fi
}

debug_step 'Détection du binaire de la release'
installer_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
case "$(uname -m)" in
  x86_64) installer_arch=amd64 ;;
  aarch64|arm64) installer_arch=arm64 ;;
  *) echo 'Architecture non prise en charge : Linux AMD64 ou ARM64 requis.' >&2; exit 1 ;;
esac
installer_host="$installer_dir/bin/youplayer-host-linux-$installer_arch"
[[ -x "$installer_host" ]] || { echo 'Archive incomplète : utiliser youplayer-install.tar.gz depuis une release, pas le clone Git.' >&2; exit 1; }
installer_engine=${1:-podman}
debug_step 'Vérification des prérequis'
"$installer_host" check "$installer_engine"

if [[ -e "$installer_dir/.env" ]]; then
  debug_step 'Démarrage avec la configuration existante'
  exec "$installer_host" install "$installer_engine"
fi

debug_step 'Saisie du compte administrateur'
[[ -t 0 ]] || { echo 'Lancer ./install.sh dans un terminal interactif.' >&2; exit 1; }
read -r -p 'Pseudo du compte administrateur : ' installer_pseudo
read -r -s -p 'Mot de passe admin (12 caractères minimum, sans apostrophe ni antislash) : ' installer_password
printf '\n'
read -r -s -p 'Confirmer le mot de passe : ' installer_confirmation
printf '\n'
[[ "$installer_password" == "$installer_confirmation" ]] || { echo 'Les mots de passe diffèrent.' >&2; exit 1; }

debug_step 'Démarrage de la première installation'
printf '%s\0%s' "$installer_pseudo" "$installer_password" | "$installer_host" install "$installer_engine"
