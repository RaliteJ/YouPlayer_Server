# Mises à jour de YouPlayer

## Depuis l’interface admin

Pour une installation issue de l’archive de release :

1. Ouvrir **Admin → Intégrations → Version du serveur**.
2. Cliquer sur **Vérifier les nouvelles releases**. L’ouverture du panneau ne contacte pas GitHub.
3. Consulter la version proposée et ses notes sur la page des releases officielles.
4. Cliquer sur **Installer la version**, puis confirmer l’interruption temporaire de la lecture.
5. Attendre la vérification du démarrage, puis recharger la page et vérifier connexion et lecture.

Les dépendances npm sont incluses dans les images validées. Il n’y a plus de
correction npm locale depuis l’admin. Un paquet sans correctif automatique ou une
mise à jour majeure se traite dans le projet avant publication d’une version.

## Installation et récupération

Le service utilisateur `youplayer-updates.service` reçoit uniquement les actions
`check` et `install`, par fichiers partagés. Les routes sont réservées aux sessions
admin et bénéficient du contrôle d’origine du serveur. Le navigateur ne choisit
ni une commande, ni une URL, ni une image : il transmet l’identifiant de la version
qui vient d’être vérifiée. Cette proposition expire après trente minutes.

Le service est l’exécutable autonome `bin/youplayer-host-linux-amd64` ou
`bin/youplayer-host-linux-arm64`, construit en Go sans bibliothèque dynamique.
Node reste dans l’image backend ; aucun interpréteur Node ni compilateur Go
n’est nécessaire sur l’hôte. Le verrou est pris directement par l’exécutable.

Le service vérifie le manifeste Ed25519 avec `keys/release-public-key.pem`, le tag,
la séquence, la plateforme et les dépôts GHCR autorisés. Les images sont référencées
par digest SHA-256. Il refuse les versions plus anciennes, les tags modifiés, les
plateformes inconnues et les changements de contrat ou de format de données.
Les installations de ce contrat utilisent le projet Compose `youplayer-server`.

Les téléchargements précèdent le remplacement du backend et du frontend. Redis,
les montages et les volumes restent en place. Avant le remplacement, un journal
privé conserve l’état précédent. En cas d’échec d’activation ou de santé, le service
rétablit les anciennes images et vérifie leur santé. Après un arrêt brutal, le même
journal permet cette récupération au redémarrage du service. Si elle échoue, l’état
`recovery-required` bloque toute nouvelle installation et demande une intervention.
Les images précédentes ne sont pas supprimées automatiquement.

Cette récupération ne restaure pas les données. Le contrat 1 accepte seulement des
versions déclarées compatibles avec le format actuel et le retour arrière. Une
migration incompatible nécessite une nouvelle procédure et une sauvegarde ; elle
ne doit pas être publiée sous ce contrat. Les sondes vérifient le démarrage et la
disponibilité du backend/Redis à travers le frontend, pas la lecture musicale réelle.

État local : `.updates/host/config.json`, `release-state.json`, `images.json` et,
pendant une transaction, `transaction.json`. Les statuts publics ne contiennent ni
secrets ni sorties de commandes. Un diagnostic de commande reste dans
`.updates/host/last-command.log`. Ne pas publier ces fichiers privés.

Pour examiner ou relancer le service :

```bash
systemctl --user status youplayer-updates.service
systemctl --user restart youplayer-updates.service
```

Ne pas lancer `down -v`, ne pas supprimer les volumes et ne pas effacer le journal
pour forcer une installation. Si le retour automatique échoue, corriger le problème
sur l’hôte puis redémarrer le service pour reprendre la récupération.

Le Compose et le service de l’hôte ne sont pas remplacés par une mise à jour d’image.
Redis reste à sa version épinglée. Les mises à jour de Redis, du service, du contrat,
de la clé publique ou du Compose demandent une maintenance explicitement documentée.

## Préparer et publier une version

Le workflow `.github/workflows/release.yml` se lance **manuellement sur un tag stable**
`vMAJEUR.MINEUR.CORRECTIF`. Il n’est pas lancé par un push ordinaire.

Configuration préalable par le mainteneur :

- Disposer de la clé privée Ed25519 correspondant à `keys/release-public-key.pem` et
  la configurer dans le secret Actions `YOUPLAYER_RELEASE_PRIVATE_KEY`. Ne jamais la
  committer. Une autre clé est refusée par le générateur d’archive.
- Autoriser Actions à publier les packages `ghcr.io/ralitej/youplayer-server-backend`
  et `ghcr.io/ralitej/youplayer-server-frontend` et les rendre **publics**. Le workflow
  vérifie l’accès anonyme avant de publier la release ; la première exécution peut
  s’arrêter tant que les packages nouvellement créés sont privés.
- Protéger les tags/releases et conserver les digests déjà publiés dans GHCR.

Mettre à jour les dépendances et leur verrou dans le projet, adapter le code si
nécessaire, puis exécuter la suite de tests. Créer un nouveau tag sur le commit
validé. Dans Actions, choisir **Publier une version YouPlayer**, sélectionner ce tag
et confirmer que le format des données permet un retour à la version précédente.

Le workflow exécute la CI Node/Chromium, construit sur des runners natifs AMD64 et
ARM64, démarre chaque stack et teste HTTPS, connexion admin et session Redis avant
publication des images. Il assemble les digests dans un manifeste signé, prépare
une archive d’installation par liste d’autorisation et publie :

- `youplayer-release.json` : manifeste signé, commun aux deux architectures ;
- `youplayer-install.tar.gz` : installateur, Compose, clé publique et service ;
- `SHA256SUMS` : checksum de l’archive.

La CI teste aussi le service Go sur Linux AMD64 et ARM64. Le packaging compile
les deux exécutables avec `CGO_ENABLED=0` et les inclut dans l’archive commune.
Les scripts Node de signature et packaging restent des outils de développement.
Pour vérifier et compiler localement (Go 1.26.2) :

```bash
(cd host && go test -race ./...)
bash scripts/build-host.sh
```

Ces commandes ne produisent pas à elles seules une release signée et ne lancent
pas d’installation. Le service hôte et le Compose ne se mettent pas à jour via
les images : une installation antérieure utilisant Node doit faire l’objet d’une
migration explicite, avec conservation de `.env`, de l’état et des volumes.

La distribution n’embarque ni `.env`, ni données, ni médias, ni clé privée, ni journaux.
La première publication et l’installation sur une machine vierge doivent être
vérifiées avant d’annoncer une version prête pour les utilisateurs. Un test local
ou une simulation du moteur ne vaut pas validation GitHub/GHCR ou Raspberry Pi.

## Installations existantes et développement

Une ancienne installation Git/Compose n’a pas l’état signé nécessaire au service.
Elle conserve la vérification informative des releases et sa mise à jour manuelle :
examiner Git, sauvegarder les données, `git pull --ff-only`, construire les images
puis recréer les services avec le **même moteur, compte, projet et fichier Compose**.
Un pull ou un simple redémarrage ne change pas les dépendances embarquées.

Pour le Compose de développement Podman de ce dépôt, après sauvegarde et avec des
sources propres :

```bash
git status --short
git pull --ff-only
podman-compose --env-file .env -p youplayer-server build --build-arg "YOUPLAYER_BUILD_COMMIT=$(git rev-parse HEAD)"
podman-compose --env-file .env -p youplayer-server up -d --no-build
```

Arrêter à la première erreur. Si les sources sont modifiées, utiliser
`YOUPLAYER_BUILD_COMMIT=unknown`. Les anciennes versions de Podman Compose peuvent
réinterpréter les `$` des mots de passe : le service autonome charge les valeurs
littéralement et passe `--env-file /dev/null`. Ne pas charger `.env` avec `source`
pour contourner ce problème. Les installations Docker existantes
conservent leur Compose adapté et leur projet. Ne jamais lancer une stack neuve
sur leurs données pour tenter une migration.
