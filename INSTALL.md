# Installer une version de YouPlayer

La distribution utilise des images préconstruites pour Linux AMD64 et ARM64
(Raspberry Pi avec un système 64 bits). Les paquets npm sont déjà installés.
Cette procédure concerne une **première installation**, dans un dossier permanent.

## Prérequis

- Linux avec systemd, Bash, `flock` et Node.js >= 22.12. npm n’est pas requis.
- Soit Podman rootless et `podman-compose`, soit Docker Engine système et le plugin
  `docker compose`, accessibles au compte utilisateur. Docker rootless n’est pas
  pris en charge par cet installateur ; utiliser Podman pour une installation rootless.
- Un accès à GitHub et aux images publiques GHCR pour l’installation et les mises à jour.
- Assez d’espace pour conserver l’ancienne et la nouvelle paire d’images.

Installer avec un compte utilisateur, sans lancer `install.sh` avec sudo. Pour que
le service utilisateur reste actif après déconnexion et redémarrage, activer une
fois sa persistance (cette commande demande les droits administrateur de l’hôte) :

```bash
sudo loginctl enable-linger "$USER"
```

Le compte du service doit conserver son accès au moteur de conteneurs. L’accès au
Docker système donne des droits élevés sur l’hôte ; réserver ce compte à l’exploitation.

## Télécharger et démarrer

Depuis les releases officielles de `RaliteJ/YouPlayer_Server`, télécharger
`youplayer-install.tar.gz` et `SHA256SUMS` d’une même version. Vérifier puis extraire
l’archive dans un dossier vide et permanent :

```bash
sha256sum -c SHA256SUMS
mkdir youplayer
tar -xzf youplayer-install.tar.gz -C youplayer
cd youplayer
./install.sh podman
# Ou, avec Docker Engine système : ./install.sh docker
```

L’archive provient de la release officielle par HTTPS. Le checksum détecte une
corruption du téléchargement ; il ne remplace pas la confiance dans cette source.
La clé publique incluse vérifie ensuite le manifeste et les versions suivantes.

L’installateur demande le pseudo et le mot de passe admin, génère les secrets
privés dans `.env`, vérifie la signature, télécharge les images par leur empreinte,
démarre les services et attend leurs sondes de santé. Il installe le service
utilisateur `youplayer-updates.service` et l’active au démarrage. Un `.env` existant
est conservé ; ses permissions doivent être `600`. Une stack, des volumes ou un
service déjà présents sont refusés pour éviter une nouvelle installation sur des données existantes.

Ouvrir **https://ADRESSE_DU_SERVEUR:8443**, se connecter avec le compte admin puis
créer un compte **user** pour la musique. Le certificat initial est autosigné ;
configurer un certificat adapté avant un usage public.

La version et les mises à jour sont dans **Admin → Intégrations → Version du serveur**.
Le service ne consulte pas GitHub au démarrage et n’installe rien spontanément.

## Exploitation

```bash
systemctl --user status youplayer-updates.service
systemctl --user restart youplayer-updates.service
```

Conserver `.env`, `.updates/host/`, `keys/`, `src/playlists/`, `src/local_song/`, les
scripts de l’installation et les volumes des comptes, sessions et certificats.
Ne pas déplacer le dossier sans adapter le service systemd. Le backend ne monte
que les demandes et les statuts du service ; il n’a accès ni au socket Docker/Podman,
ni à la configuration privée de l’updater.

Si l’installation échoue après le démarrage, elle conserve les données. Ne pas
supprimer les volumes pour la relancer. Examiner l’état et le diagnostic local
`.updates/host/last-command.log` ; voir [UPDATES.md](UPDATES.md). Ces journaux sont privés.

Avec Podman, les services sont lancés avec `--in-pod false` : le mode utilisateur
`keep-id` du backend est incompatible avec un pod partagé. Si une ancienne archive
échoue avec `--userns and --pod cannot be set together`, appliquer le correctif
aux scripts de l'installation puis recréer les conteneurs concernés hors du pod,
en conservant leurs volumes et leur configuration. Un Redis resté dans l'ancien
pod empêche également la création du backend hors pod.

Les installations existantes depuis Git/Compose nécessitent une migration explicite
conservant leurs montages et volumes. L’installateur ne les convertit pas automatiquement.
Le dépôt Git reste utilisable pour développer et construire manuellement les images ;
`install.sh` attend les fichiers d’une archive de release, notamment son manifeste signé.
