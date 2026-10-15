# Installer YouPlayer sans construire les images

Cette méthode utilise `youplayer-install.tar.gz`, joint aux nouvelles releases
publiées en mode registre (GHCR ou autre registre configuré). Une release contenant
seulement `youplayer-images.tar` utilise l’ancienne distribution ; elle ne fournit
pas cet installateur. Le code doit avoir été publié dans une nouvelle release
avant que cette archive soit disponible.

## Préparer la machine

Utiliser Linux, **le compte utilisateur Podman, sans sudo**, et une architecture
correspondant à la release (`linux/amd64` ou `linux/arm64`). Chaque release fournit
une seule architecture. Le port HTTPS `8443` doit être disponible.

Outils requis sur l’hôte : **Podman, podman-compose, Node.js >= 22.12, Bash,
Python 3 avec PyYAML et python-dotenv, tar et flock**. Aucun `npm install`, Git,
Chromium ni build des images n’est nécessaire sur le serveur. Node et Python
servent à l’installation et aux outils de mise à jour, pas à exécuter l’application
hors des conteneurs. L’installateur vérifie les outils, sans installer de paquets
système ni lancer sudo.

Si les images GHCR sont privées, faire d’abord `podman login ghcr.io`, dans ce même
compte. Pour un autre registre, utiliser son adresse. Un échec de téléchargement
laisse la configuration locale intacte.

## Installer

1. Télécharger `youplayer-install.tar.gz` depuis une release de confiance de
   [RaliteJ/YouPlayer_Server](https://github.com/RaliteJ/YouPlayer_Server/releases).
2. Extraire l’archive dans un dossier neuf et permanent, puis lancer :

   ```bash
   tar -xzf youplayer-install.tar.gz
   cd youplayer-server
   ./install.sh
   ```

3. Choisir le pseudo et le mot de passe du compte administrateur. Le mot de passe
   est saisi sans affichage, comporte au moins 12 caractères et ne contient pas
   d’apostrophe ni d’antislash. Les secrets de session et Spotify sont générés
   aléatoirement ; `.env` est créé avec des permissions `0600`.
4. Ouvrir `https://ADRESSE_DU_SERVEUR:8443`. Le certificat initial est autosigné :
   vérifier l’adresse et configurer ensuite un certificat de confiance pour
   l’accès souhaité. Se connecter comme admin, puis créer un compte **user**
   pour écouter la musique.

L’installateur vérifie la signature Ed25519 du manifeste fourni, la plateforme,
les digests et les IDs des images téléchargées, puis la topologie et la santé
des trois services. Les deux images sont téléchargées par digest, puis associées
aux tags locaux du Compose ; aucun build n’est effectué. Les tags locaux
permettent de redémarrer plus tard avec la version choisie depuis Admin.
L’archive contient les outils hôte et la clé publique du signataire ; sa provenance
doit être vérifiée avant d’exécuter son code. La signature du manifeste ne signe
pas à elle seule le code de l’installateur.

Une configuration `.env` existante est conservée et validée. L’installateur refuse
une installation déjà démarrée : il ne remplace pas ses conteneurs ni ses données.
Après un échec avant démarrage, corriger le problème et relancer `./install.sh`.
Si des conteneurs existent déjà après un démarrage partiel, inspecter leur état
avec la commande ci-dessous ; l’installateur ne les supprime pas pour recommencer.

## Exploiter et mettre à jour

Depuis le dossier d’installation :

```bash
podman-compose --env-file .env -p youplayer-server ps
podman-compose --env-file .env -p youplayer-server up -d --no-build
```

Conserver ensemble `.env`, `.updates/`, `src/playlists/`, `src/local_song/` et les
volumes Podman du projet. Ne pas lancer `down -v` pour mettre à jour. Les API
YouTube et Spotify restent facultatives ; leurs valeurs se règlent dans `.env`.
Le guide de build du dépôt explique ces intégrations.

La source des mises à jour et la clé publique sont préparées par l’installateur.
Pour rendre les demandes Admin disponibles, lancer explicitement le service hôte
dans ce même dossier et sous le même utilisateur :

```bash
node scripts/update-service.mjs run
```

Ce processus doit rester actif ; son lancement au démarrage de l’hôte reste à
configurer par l’administrateur. Il n’installe rien à son lancement : utiliser
**Vérifier**, puis **Installer** dans Admin. Les contrôles de signature, sauvegarde
et retour arrière existants restent actifs. Une mise à jour d’images ne remplace
ni cet installateur, ni Compose, ni les outils hôte.
