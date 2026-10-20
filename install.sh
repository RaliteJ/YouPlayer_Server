#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
fail() { echo "$*" >&2; exit 1; }

# Prérequis : tout tourne avec Podman utilisateur, sans sudo ni Node sur l'hôte.
[[ $(uname -s) == Linux && $(id -u) != 0 ]] || fail 'Utiliser Linux avec le compte Podman utilisateur, sans sudo.'
for tool in git podman podman-compose openssl curl; do
  command -v "$tool" >/dev/null || fail "Installer $tool avant de continuer."
done
git rev-parse --is-inside-work-tree >/dev/null
podman info >/dev/null
podman-compose --version >/dev/null
containers=$(podman ps -a --format '{{.Names}}')
[[ $containers != *youplayer-server_* ]] || fail 'Des conteneurs YouPlayer existent déjà, même arrêtés.
Supprimer .env ne réinitialise pas cette installation.
Pour conserver les données, restaurer le .env précédent avant de suivre UPDATES.md.'

# Première installation : créer la configuration sans écraser un fichier existant.
if [[ ! -e .env && ! -L .env ]]; then
  read -r -p 'Pseudo admin : ' pseudo
  read -r -s -p 'Mot de passe admin (12 caractères minimum, sans apostrophe ni antislash) : ' password
  printf '\n'
  read -r -s -p 'Confirmer le mot de passe : ' confirmation
  printf '\n'
  [[ $password == "$confirmation" ]] || fail 'Les mots de passe diffèrent.'
  [[ $pseudo =~ ^[a-zA-Z0-9_.@-]{1,100}$ ]] || fail 'Pseudo invalide.'
  [[ ${#password} -ge 12 && $password != *[\'\\]* && $password != *$'\r'* ]] || fail 'Mot de passe invalide.'
  session_secret=$(openssl rand -hex 48)
  spotify_secret=$(openssl rand -hex 48)
  ( set -o noclobber; cat > .env <<EOF
COMPOSE_PROJECT_NAME='youplayer-server'
YOUPLAYER_ADMIN_PSEUDO='$pseudo'
YOUPLAYER_ADMIN_PASSWORD='$password'
YOUPLAYER_SESSION_SECRET='$session_secret'
YOUPLAYER_SPOTIFY_TOKEN_SECRET='$spotify_secret'
YOUPLAYER_LOG_LEVEL='info'
EOF
  )
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

# Construire avant de démarrer ; ne jamais supprimer les données en cas d'échec.
mkdir -p src/playlists src/local_song .updates/{requests,status,host}
chmod 700 .updates/{requests,status,host}
commit=unknown
[[ -n $(git status --porcelain) ]] || commit=$(git rev-parse HEAD)
compose=(podman-compose --env-file /dev/null -p youplayer-server -f docker-compose.yml)
[[ ! -L .updates/host/install.log ]] || fail 'Le journal ne doit pas être un lien symbolique.'
touch .updates/host/install.log
chmod 600 .updates/host/install.log
echo 'Construction des images… (diagnostic privé : .updates/host/install.log)'
"${compose[@]}" build --build-arg "YOUPLAYER_BUILD_COMMIT=$commit" > .updates/host/install.log 2>&1
"${compose[@]}" up -d --no-build >> .updates/host/install.log 2>&1
curl --fail --silent --insecure --retry 60 --retry-all-errors --retry-delay 2 --max-time 5 \
  --output /dev/null https://127.0.0.1:8443/health/ready || fail 'Démarrage à vérifier : consulter .updates/host/install.log.'
echo 'YouPlayer est prêt : https://ADRESSE_DU_SERVEUR:8443'
echo 'Connecte-toi en admin, puis crée un compte user pour écouter la musique.'
