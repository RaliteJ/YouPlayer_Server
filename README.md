<div align="center">

# 🎵 YouPlayer Server

### Votre musique. Vos playlists. Votre serveur.

Un lecteur musical personnel pour réunir YouTube, le catalogue Spotify et vos fichiers audio dans une même interface web.

**Auto-hébergé · Interface web · Node.js**

[👀 Découvrir](#a-propos) · [✨ Fonctionnalités](#fonctionnalites) · [🚀 Prise en main](#prise-en-main) · [🛠️ Installation et build](#installation-et-build)

</div>

## 📋 Sommaire

- [ 👀 À propos](#a-propos)
- [ ✨ Fonctionnalités](#fonctionnalites)
- [🚀 Prise en main pour écouter](#prise-en-main)
- [🔐 Comptes, confidentialité et services musicaux](#comptes-et-confidentialite)
- [👷 Contribuer](#contribuer)
- [📦 Installation sans compilation](#installation-sans-build)
- [🛠️ Installation et build — guide technique](#installation-et-build)
  - [Prérequis et architecture](#prerequis)
  - [Configurer une première installation](#configuration)
  - [Construire et démarrer les services](#build)
  - [Configurer les API YouTube et Spotify](#api)
  - [Vérifier les connexions depuis Admin](#connexions-admin)
  - [Installer les dépendances et lancer les tests](#tests)
  - [Tests automatiques sur GitHub](#ci)
  - [Construire le pont Spotify facultatif](#extension)
  - [Exploitation et mises à jour](#exploitation)
  - [Organisation du projet](#organisation)
- [Auteur et avertissement](#disclaimer)

<a id="a-propos"></a>

## 👀 À propos

YouPlayer rassemble la recherche musicale, les playlists et la lecture audio dans une interface pensée pour un usage personnel. Un morceau trouvé sur YouTube, une référence Spotify ou un fichier audio conservé sur votre appareil peut rejoindre votre bibliothèque et vos playlists.

L'application s'utilise depuis un navigateur. Elle fonctionne avec un serveur que vous installez et gérez vous-même : c'est le principe de l'**auto-hébergement**. Si quelqu'un a déjà installé YouPlayer pour vous, vous avez seulement besoin de l'adresse du site et d'un compte de lecture.

Pour installer votre propre instance, consultez l’[installation sans compilation](#installation-sans-build)
ou le [guide technique avec build](#installation-et-build).

<a id="fonctionnalites"></a>

## ✨ Fonctionnalités

| Fonction | Ce que vous pouvez faire |
|:---|:---|
| 🎵 **Un lecteur commun** | Lire, mettre en pause et passer au morceau précédent ou suivant depuis la même barre de contrôle. |
| 📚 **Playlists** | Créer des playlists, y ajouter des morceaux et choisir les collections à écouter. |
| 🔎 **Recherche musicale** | Chercher des titres dans les vues YouTube et Spotify. |
| 💿 **Fichiers locaux** | Ajouter des fichiers audio depuis votre appareil. |
| 🔀 **Lecture aléatoire** | Mélanger la sélection pour varier l'ordre des morceaux. |
| 🌐 **Interface web** | Parcourir la bibliothèque et piloter le lecteur depuis un navigateur. |
| 👤 **Comptes séparés** | Utiliser un compte de lecture personnel et réserver l'administration à la gestion du serveur. |
| 🧩 **Pont Spotify facultatif** | Accéder aux playlists personnelles du WebPlayer avec une extension compatible installée séparément. |

Spotify sert à rechercher des références musicales et à importer des playlists. La disponibilité d'une référence dans son catalogue ne garantit pas qu'une source audio correspondante pourra être trouvée ou lue.

<a id="prise-en-main"></a>

## 🚀 Prise en main pour écouter

Une fois le serveur installé :

1. Ouvrez l'adresse YouPlayer fournie par la personne qui gère le serveur.
2. Connectez-vous avec votre compte **user**, le compte destiné à la musique.
3. Choisissez votre musique dans les vues YouTube, Spotify ou fichiers locaux.
4. Ajoutez les morceaux à une playlist, existante ou créée pour l'occasion.
5. Sélectionnez les playlists à écouter depuis l'accueil, puis lancez la lecture.

Les contrôles du lecteur permettent ensuite de mettre en pause, de changer de morceau et d'activer la lecture aléatoire.

La lecture est sauvegardée sur votre compte : en ouvrant YouPlayer avec le même compte sur un autre appareil, vous retrouvez le morceau, sa position et la file à venir. La position est enregistrée environ chaque seconde pendant la lecture, ainsi qu'à la pause et lorsque vous quittez la page. L'ancien appareil se met en pause lorsqu'il détecte la reprise ailleurs. Si le navigateur bloque le démarrage automatique du son, appuyez sur Lecture pour reprendre à la position retrouvée.

Un compte **admin** ouvre les outils de gestion. Pour écouter, demandez un compte **user** ou créez-en un depuis Admin si vous gérez vous-même l'instance.

<a id="comptes-et-confidentialite"></a>

## 🔐 Comptes, confidentialité et services musicaux

Les comptes admin sont réservés à la gestion du serveur et des utilisateurs. Les comptes user disposent de leur espace musical ; l'authentification et les contrôles d'accès protègent les données et les flux privés.

Cette distribution ne contient ni données utilisateur, ni compte précréé, ni secret, ni extension signée. Elle inclut la clé publique de vérification des versions officielles. Le panneau Admin indique la configuration et les derniers contrôles de connexion YouTube/Spotify sans afficher les secrets.

Le catalogue public Spotify peut fonctionner sans compte Spotify personnel. L'OAuth Spotify est une configuration facultative ; les playlists personnelles du WebPlayer utilisent le pont d'extension. L'extension s'installe séparément et doit être associée à l'adresse HTTPS exacte de votre instance.

Les recherches, imports et téléchargements utilisent des services externes. L'auto-hébergement ne garantit pas l'anonymat de l'utilisateur ou du serveur vis-à-vis de Spotify, YouTube ou des autres services contactés.

<a id="contribuer"></a>

## 👷 Contribuer

Les améliorations de l'interface, de la documentation et de la fiabilité du lecteur sont les bienvenues. Pour une contribution, décrivez le problème, le comportement attendu et les vérifications effectuées.

Lisez [AGENTS.md](AGENTS.md) avant de modifier le projet. Utilisez des exemples fictifs et conservez les comptes, clés, playlists personnelles, médias, configurations locales et journaux hors des contributions.

---

<a id="installation-sans-build"></a>

## 📦 Installation sans compilation

Téléchargez l’archive `youplayer-install.tar.gz` d’une release officielle puis lancez
`./install.sh podman` (ou `./install.sh docker`). Les images AMD64/ARM64 contiennent
les dépendances npm validées : aucune compilation ni commande npm n’est nécessaire
sur le serveur installé. Voir [INSTALL.md](INSTALL.md) pour les prérequis et la configuration.

Dans **Admin → Intégrations → Version du serveur**, cliquez sur **Vérifier les
nouvelles releases**, puis **Installer la version**. Le service installé sur l’hôte
vérifie la signature et les empreintes, remplace les images et contrôle leur santé.
L’installation est toujours explicite. Voir [UPDATES.md](UPDATES.md).

Les installations depuis les sources gardent le parcours manuel décrit dans
[UPDATES.md](UPDATES.md#installations-existantes-et-developpement).

<a id="installation-et-build"></a>

## 🛠️ Installation et build — guide technique

Cette partie s'adresse aux personnes qui installent, développent ou maintiennent le serveur. **Construire les images** (le build) prépare le logiciel et ses dépendances ; **démarrer la stack** lance les trois services nécessaires à son fonctionnement.

Toutes les commandes ci-dessous s'exécutent à la racine de ce dépôt, dans le dossier contenant `docker-compose.yml`. Aucun lancement, déploiement ou publication n'est automatique au clonage.

<a id="prerequis"></a>

### 1. Prérequis et architecture

- **Linux, Git, Bash, OpenSSL, curl, Podman et podman-compose** pour `./install.sh`.
- **Node.js ≥ 22.12** sur l’hôte uniquement pour les outils Node locaux et les tests.
- **Chromium local** uniquement pour les tests de l’interface dans un navigateur.
- Un accès réseau pour télécharger les images, paquets et dépendances pendant la construction, puis pour les fonctions musicales externes utilisées.

| Service | Rôle |
|:---|:---|
| `backend` | Serveur Node/Express, authentification, bibliothèque et intégrations musicales. |
| `frontend` | Interface HTML/CSS/JavaScript servie par Nginx et proxy HTTPS vers le backend. |
| `redis` | Stockage des sessions de connexion. |

L'image backend contient **FFmpeg et yt-dlp**, mais **n'embarque pas Chromium**. Les fonctions Spotify courantes utilisent HTTP ou le pont du navigateur utilisateur. Les diagnostics Spotify nécessitant un navigateur sont désactivés dans cette image par `YOUPLAYER_SPOTIFY_BROWSER_ENABLED=false`. Puppeteer reste installé pour l'outillage ; activer ce réglage seul n'installe aucun navigateur. Voir [PRODUCTION.md](PRODUCTION.md).

<a id="configuration"></a>

### 2. Configurer une première installation manuellement

Avec `./install.sh`, la configuration et le démarrage sont déjà pris en charge.
Les étapes 2 et 3 ci-dessous décrivent la procédure manuelle.

Créez votre configuration locale sans écraser un fichier existant :

```bash
test -f .env || cp .env.example .env
chmod 600 .env
```

Ouvrez `.env` dans votre éditeur. **Les valeurs de `.env.example` sont des descriptions, pas une configuration utilisable** : remplacez chacune par une valeur adaptée ou laissez vide une option facultative inutilisée.

Configurez au minimum :

| Variable | Valeur à renseigner |
|:---|:---|
| `COMPOSE_PROJECT_NAME` | `youplayer-server`, le nom attendu par les outils d'exploitation. |
| `YOUPLAYER_ADMIN_PSEUDO` | Le pseudo du premier administrateur. |
| `YOUPLAYER_ADMIN_PASSWORD` | Un mot de passe personnel d'au moins **12 caractères**. |
| `YOUPLAYER_SESSION_SECRET` | Un secret aléatoire fort pour protéger les sessions. |
| `YOUPLAYER_LOG_LEVEL` | Un niveau valide, par exemple `info`. |

Pour générer le secret de session :

```bash
openssl rand -hex 48
```

Copiez le résultat dans `YOUPLAYER_SESSION_SECRET`, uniquement dans `.env`. Pour l'OAuth Spotify, générez une deuxième valeur indépendante pour `YOUPLAYER_SPOTIFY_TOKEN_SECRET`.

Laissez les clés YouTube et les variables Spotify facultatives vides si vous ne les utilisez pas. Les champs `YOUPLAYER_SPOTIFY_WEB_USERNAME` et `YOUPLAYER_SPOTIFY_WEB_PASSWORD` concernent uniquement un diagnostic navigateur facultatif ; ils ne sont pas nécessaires au catalogue public et ce diagnostic est désactivé dans l'image fournie.

Préparez les dossiers locaux utilisés par les médias et le statut des versions, puis contrôlez la configuration initiale :

```bash
mkdir -p src/playlists src/local_song .updates/requests .updates/status
chmod 700 .updates .updates/requests .updates/status
```

Si Node.js ≥ 22.12 est installé sur l’hôte, vous pouvez aussi vérifier la configuration :

```bash
node scripts/production.mjs preflight
```

Le contrôle `preflight` rapporte des booléens sans afficher les secrets ; il ne teste pas les services musicaux ou un certificat public. Corrigez les contrôles en échec avant le premier lancement.

<a id="build"></a>

### 3. Construire et démarrer les services

Pour construire les images et démarrer backend, frontend et Redis :

```bash
podman-compose -p youplayer-server up -d --build
```

La première construction télécharge les images de base et installe les dépendances. Les Dockerfiles exécutent les étapes nécessaires : vous n'avez pas besoin d'installer les dépendances Node sur l'hôte pour ce build.

Pour séparer construction et démarrage :

```bash
podman-compose -p youplayer-server build
podman-compose -p youplayer-server up -d
```

Vérifiez l'état des services :

```bash
podman-compose -p youplayer-server ps
```

Ouvrez **https://localhost:8443**. Le frontend génère un certificat autosigné pour `localhost` et `127.0.0.1` ; le navigateur peut demander de confirmer son utilisation pour cet essai local. Configurez un domaine et un certificat public avant un usage distant.

Au premier démarrage sans admin existant, connectez-vous avec les identifiants
admin définis dans `.env`, puis créez un compte **user** depuis Admin pour écouter
la musique. **Modifier `YOUPLAYER_ADMIN_PASSWORD` dans `.env` ne change pas le mot
de passe d’un admin déjà enregistré**, même après recréation du backend.
Conservez le mot de passe du compte existant ; une réinitialisation doit être
faite explicitement, sans supprimer le volume des comptes.

Les comptes, playlists enregistrées dans le store et connexions chiffrées sont conservés dans le volume privé `youplayer_data`. Les sessions utilisent `redis_data`. Les dossiers `src/playlists/` et `src/local_song/` sont également montés depuis l'hôte : préservez-les avec vos données.

Conservez le nom de projet **`youplayer-server`** et utilisez le même compte Podman utilisateur pour les opérations d'exploitation.

Après modification des variables de `.env`, recréez le backend pour les appliquer :

```bash
podman-compose -p youplayer-server up -d --force-recreate backend
```

Après modification du code, reconstruisez les images concernées avec `up -d --build`. Sauvegardez les données avant une mise à jour. **N'utilisez pas `down -v`** : cette commande supprime les volumes.

**En cas de problème d’installation ou de connexion**

- « Des conteneurs YouPlayer existent déjà » : vérifiez leur état avec
  `podman ps -a`. Des conteneurs arrêtés bloquent aussi une nouvelle installation.
- Mot de passe refusé : si vous réutilisez le volume des comptes, utilisez le mot
  de passe de l’admin existant. Recréer `.env` ne réinitialise pas ce compte.
- Plusieurs clones du dépôt : exécutez les commandes dans le dossier de
  l’installation active, avec son `.env` et le même compte Podman. Un autre clone
  ne constitue pas une installation indépendante avec le même nom de projet.
- Échec du script pendant la construction ou le démarrage : consultez localement
  `.updates/host/install.log`, puis `podman-compose -p youplayer-server ps` et
  `podman-compose -p youplayer-server logs --tail=50`. Ne partagez pas les journaux
  bruts ni le contenu de `.env`.

<a id="api"></a>

### 4. Configurer les API YouTube et Spotify

Gardez les valeurs réelles dans `.env`, exclu de Git. Ne les recopiez jamais dans le README ou `.env.example`.

#### YouTube : `YOUPLAYER_YOUTUBE_API_KEY`

Cette clé est facultative et sert aux recherches et imports via l'API YouTube.

1. Ouvrez la [console Google Cloud](https://console.cloud.google.com/) et créez ou sélectionnez un projet.
2. Dans **API et services > Bibliothèque**, recherchez **YouTube Data API v3** et activez-la.
3. Dans **API et services > Identifiants**, créez une **clé API**.
4. Dans les restrictions de la clé, limitez les API autorisées à **YouTube Data API v3**.
5. Copiez la clé dans `YOUPLAYER_YOUTUBE_API_KEY` de `.env`.

Les requêtes partent du backend. Pour une restriction par adresse IP, utilisez l'adresse IP publique de sortie du serveur. Les quotas se consultent dans Google Cloud. Ces requêtes publiques ne nécessitent pas de client OAuth Google.

Consultez le [guide YouTube Data API](https://developers.google.com/youtube/v3/getting-started), la [création des identifiants](https://developers.google.com/youtube/registering_an_application) et les [restrictions des clés API](https://docs.cloud.google.com/docs/authentication/api-keys) pour les règles du fournisseur.

#### Spotify : OAuth facultatif

Le catalogue public fonctionne sans ces identifiants. Cette configuration concerne l'OAuth ; les playlists personnelles du WebPlayer utilisent toujours le pont d'extension.

1. Connectez-vous au [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), puis créez une application.
2. Donnez-lui un nom et une description, sélectionnez **Web API** si demandé et acceptez les conditions du fournisseur.
3. Dans les paramètres, enregistrez l'URI de retour de votre serveur, par exemple `https://musique.example.com/auth/spotify/callback`.
4. Copiez le **Client ID** et le **Client Secret** dans les variables correspondantes de `.env`.
5. Renseignez exactement la même URI dans `YOUPLAYER_SPOTIFY_REDIRECT_URI`.
6. Générez un secret de chiffrement indépendant pour `YOUPLAYER_SPOTIFY_TOKEN_SECRET` avec la commande Node de la première installation.

| Variable | Contenu |
|:---|:---|
| `YOUPLAYER_SPOTIFY_CLIENT_ID` | Client ID du Dashboard. |
| `YOUPLAYER_SPOTIFY_CLIENT_SECRET` | Client Secret de la même application. |
| `YOUPLAYER_SPOTIFY_REDIRECT_URI` | URI de retour enregistrée dans cette application. |
| `YOUPLAYER_SPOTIFY_TOKEN_SECRET` | Secret aléatoire distinct du secret de session, d'au moins 32 caractères. |
| `YOUPLAYER_SPOTIFY_SCOPES` | Permissions OAuth souhaitées, séparées par des espaces ; voir `.env.example`. |

Pour un essai local, utilisez `https://127.0.0.1:8443/auth/spotify/callback` comme URI de retour et ouvrez YouPlayer sur **https://127.0.0.1:8443** pour conserver le même hôte de session. Domaine, port, chemin et barre finale doivent correspondre à l'URI enregistrée. Vérifiez les exigences actuelles dans les [paramètres des applications](https://developer.spotify.com/documentation/web-api/concepts/apps) et les [règles des URI de retour](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).

Après configuration, recréez le backend avec la commande de la section précédente. La connexion Spotify personnelle est réservée aux comptes user.

<a id="connexions-admin"></a>

### 5. Vérifier les connexions depuis Admin

Le panneau **Connexions aux services** distingue l'API YouTube, le catalogue public Spotify et les identifiants OAuth Spotify. À l'ouverture, il affiche la configuration et les derniers résultats conservés par le serveur sans effectuer d'appel externe.

**Vérifier les connexions** lance les sondes et affiche la date du test ainsi que leur état : accessible, non configurée, accès refusé, quota dépassé, limite de requêtes atteinte, délai dépassé ou indisponible. Après un redémarrage, les résultats doivent être vérifiés de nouveau.

Les contrôles utilisent des ressources publiques et les identifiants d'application configurés, jamais les playlists ou comptes personnels :

- **YouTube** : requête `videos.list` ; voir sa [documentation](https://developers.google.com/youtube/v3/docs/videos/list) pour le quota.
- **Spotify public** : obtention d'une session invitée.
- **Spotify OAuth** : obtention d'un [jeton d'application](https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow), sans vérifier l'URI de retour ou les autorisations d'un utilisateur.

Les appels sont limités dans le temps et les résultats réutilisés pendant **30 secondes**. Le serveur limite aussi les contrôles répétés. Les clés, jetons et erreurs brutes ne sont pas renvoyés à l'interface. Une sonde réussie ne garantit pas toutes les recherches ou la lecture des médias. Les distributions préconstruites se mettent à jour sur action explicite depuis Admin ; les installations de développement conservent les commandes sur l’hôte.

<a id="tests"></a>

### 6. Installer les dépendances et lancer les tests

Pour travailler sur les sources et exécuter la suite locale :

```bash
npm --prefix src ci
npm --prefix src test
```

L'installation télécharge les dépendances depuis npm. La suite couvre le serveur, le frontend et des scénarios Chromium avec des fixtures synthétiques et des réponses simulées pour les intégrations.

Les tests navigateur utilisent `/usr/bin/chromium` par défaut. Si Chromium est installé ailleurs, indiquez son chemin réel :

```bash
PUPPETEER_EXECUTABLE_PATH=/chemin/vers/chromium npm --prefix src test
```

Les tests du pont externe sont ignorés si ses sources ne sont pas fournies explicitement via `YOUPLAYER_EXTENSION_DIR`. Ces sources ne font pas partie du serveur. Un test ignoré faute de navigateur, de serveur localhost ou de sources externes **n'est pas une validation réussie**.

Pour une modification ciblée, vous pouvez lancer directement le fichier de test concerné, par exemple :

```bash
node --test test/server/config.test.js
```

Les tests locaux avec des données fictives ne remplacent pas une vérification des intégrations réelles, d'un déploiement ou de la lecture sur appareil physique, notamment écran verrouillé.

<a id="ci"></a>

### 7. Tests automatiques sur GitHub

Le workflow [.github/workflows/ci.yml](.github/workflows/ci.yml) s'exécute pour les push de branche, les pull requests et à la demande via **Actions > Tests YouPlayer > Run workflow**.

| Contrôle | Vérifications |
|:---|:---|
| **Tests Node et Chromium** | Node 24, installation de Chrome for Testing et de ses dépendances système, puis suite de tests sur un runner Ubuntu temporaire. Si le navigateur ou le serveur de test ne démarre pas, la CI échoue. |
| **Stack Docker HTTPS** | Construction des vrais Dockerfiles, démarrage de backend/frontend/Redis, attente des sondes de santé, puis vérification HTTPS, connexion admin, session Redis, accès et déconnexion. |

Aucune clé Spotify/YouTube, aucun `.env` local et aucun secret GitHub ne sont nécessaires à ces tests. La stack de test utilise un compte admin et des secrets aléatoires générés dans un fichier temporaire, ainsi qu'un certificat autosigné. Les intégrations musicales réelles ne sont pas configurées ; leurs cas sont couverts par des réponses simulées. Les tests du pont externe restent ignorés sans ses sources.

Les dépendances, le navigateur et les images sont téléchargés pendant la CI. Les conteneurs et volumes de test sont supprimés en fin de job. Le workflow ne modifie aucun serveur en service.

Après un push explicite sur GitHub, consultez les résultats dans **Actions** et dans les pull requests. Vous pouvez rendre les contrôles **Tests Node et Chromium** et **Stack Docker HTTPS** obligatoires dans les règles de protection de branche.

Le workflow de publication des anciennes images signées a été retiré. Les mises à jour utilisent le dépôt Git.

Documentation : [tests Node sur GitHub Actions](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs) et [installation du navigateur Puppeteer](https://pptr.dev/browsers-api).

<a id="extension"></a>

### 8. Construire le pont Spotify facultatif

Aucun XPI ni dépôt voisin n'est fourni ou sélectionné automatiquement. Pour utiliser le pont, installez séparément une extension compatible, puis associez l'origine HTTPS exacte de YouPlayer depuis son popup. Le jeton d'accès (bearer) reste dans l'extension.

Pour construire un paquet depuis des sources compatibles, vous avez besoin de `zip` et `unzip`. Indiquez explicitement leur dossier :

```bash
YOUPLAYER_EXTENSION_DIR=/chemin/vers/extension npm --prefix src run extension:build
YOUPLAYER_EXTENSION_DIR=/chemin/vers/extension npm --prefix src run extension:check
```

Le build écrit `src/downloads/youplayer-spotify-bridge.xpi`, ignoré par Git. Le contrôle compare le paquet aux sources locales ; il ne valide ni une signature ni l'installation dans un navigateur. Signature et distribution sont des étapes distinctes.

Le dossier `src/downloads/` est copié dans l'image frontend lors du build. Reconstruisez cette image si vous souhaitez y inclure un paquet préparé. Aucune installation d'extension n'est proposée par défaut.

<a id="exploitation"></a>

### 9. Exploitation et mises à jour

Consultez [PRODUCTION.md](PRODUCTION.md) pour les procédures complètes. Les outils utilisent le projet Compose `youplayer-server` et doivent être exécutés avec le même compte Podman utilisateur.

Pour un contrôle ponctuel de la santé et de l'espace disque :

```bash
node scripts/production.mjs monitor
```

Aucune supervision n'est installée automatiquement. Après installation ou mise à jour, vérifiez la connexion, la persistance des données et la lecture. Les sondes du serveur sont `/health/live` et `/health/ready`.

Les mises à jour sont effectuées par l’utilisateur sur l’hôte. Après sauvegarde,
depuis le dépôt de l’installation :

```bash
git status --short
git pull --ff-only
podman-compose --env-file .env -p youplayer-server build
podman-compose --env-file .env -p youplayer-server up -d --no-build
```

**Arrêtez-vous à la première erreur.** Ne lancez le redémarrage qu’après une
construction réussie. Le code est intégré aux images : `git pull` seul ne change
pas l’application en cours d’exécution. Le redémarrage interrompt la lecture.
Conservez le même moteur, compte et projet Compose pour retrouver vos volumes.

[UPDATES.md](UPDATES.md) détaille les contrôles, le cas Docker Compose, la
migration des anciennes installations et la préservation des valeurs `$` avec
les anciennes versions de Podman Compose. Il n’y a plus de sauvegarde ou de
retour arrière automatique, ni de worker à lancer. N’utilisez pas `down -v`.

Ne partagez jamais `.env`, `.updates/`, les sauvegardes, journaux, médias ou données des utilisateurs. Toute distribution publique doit conserver uniquement des exemples descriptifs sans valeurs personnelles.

#### Dépendances et mises à jour

Les dépendances npm sont actualisées dans le projet, testées en CI et intégrées aux
images de chaque release. L’onglet Sécurité explique ce fonctionnement ; les
utilisateurs installent une version complète depuis **Admin → Intégrations**.
L’ancien service de correction npm sur l’hôte n’est plus utilisé.

Pour contribuer, mettre à jour `src/package.json` et `src/package-lock.json`,
exécuter les tests et préparer une release selon [UPDATES.md](UPDATES.md).
Un audit npm sans vulnérabilité connue ne garantit pas l’absence de faille.

### 10. Organisation du projet

| Chemin depuis la racine | Rôle |
|:---|:---|
| `src/index.html` | Structure de l'interface et des vues. |
| `src/style.css` | Apparence du lecteur, de la navigation et des playlists. |
| `src/app.js` et modules `src/*.js` | Interactions du navigateur, bibliothèque, lecteur et comptes. |
| `src/server/` | Serveur Express, authentification et intégrations musicales. |
| `src/package.json` et `src/package-lock.json` | Scripts et dépendances Node. |
| `src/downloads/` | Paquets facultatifs copiés dans l'image frontend. |
| `test/` | Tests serveur, frontend et navigateur. |
| `scripts/` | Outils de build, exploitation, sauvegarde et mises à jour. |
| `Dockerfile.backend` et `Dockerfile.frontend` | Recettes de construction des deux images applicatives. |
| `docker-compose.yml` et `nginx.conf` | Services, volumes, réseaux et proxy HTTPS. |
| `.env.example` | Modèle descriptif de configuration, sans secret réel. |
| `.github/workflows/` | Tests CI et publication des releases. |

<a id="disclaimer"></a>

## Auteur et avertissement

YouPlayer Server was created and is maintained by [RaliteJ](https://github.com/RaliteJ).

Copyright © 2026 RaliteJ. All rights reserved.

This project is provided “as is”, without warranties of any kind.
It is not affiliated with, endorsed by, or sponsored by Spotify, YouTube, or Google.

Users are responsible for complying with applicable laws, copyright requirements,
and the terms of service of any third-party platforms they access.
This project does not grant permission to download, copy, or distribute copyrighted content.

### Passages non musicaux (SponsorBlock)

Dans **Paramètres**, activez **Passer les passages sans musique sur YouTube**. Cette option est désactivée par défaut et enregistrée séparément pour chaque compte dans le navigateur. Dans le lecteur agrandi, décochez la même option pour écouter le morceau en cours en entier ; elle se réactive au changement de morceau.

Seule la catégorie `music_offtopic` est utilisée. Les repères communautaires sont filtrés et comparés à la durée du morceau. Le fichier audio reste intact et la progression conserve les temps de la vidéo originale, y compris pour la reprise de lecture. Sans repères, en cas de panne ou si le flux progressif ne permet pas de se déplacer, le morceau continue intégralement. Cette intégration concerne les titres YouTube du lecteur web ; elle ne pilote pas le service audio natif Android ni les correspondances YouTube des titres Spotify.

Le serveur interroge l’API SponsorBlock uniquement après activation, à partir des quatre premiers caractères du SHA-256 de l’identifiant vidéo. Les réponses utiles sont gardées en mémoire pendant six heures (256 titres au maximum) ; les échecs sont gardés une minute. Aucun compte, média, historique d’écoute, vote ou signalement n’est envoyé. Le service externe reçoit néanmoins l’adresse IP du serveur et le préfixe demandé.

Données de [SponsorBlock](https://sponsor.ajay.app/), sous licence [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). Seuls les repères non musicaux valides sont conservés ; aucune base modifiée n’est publiée.
