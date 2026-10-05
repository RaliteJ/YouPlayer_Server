# YouPlayer_Server
first commit

## Installation

Serveur Node/Express, interface navigateur et proxy HTTPS pour une bibliotheque
musicale personnelle. Les comptes admin sont reserves a la gestion ; creer un
compte user distinct pour la lecture. Le panneau Admin affiche la configuration
et les derniers controles de connexion YouTube/Spotify, sans communiquer de secret.

Cette distribution ne contient ni donnees utilisateur, ni compte precree, ni
secret, ni configuration de mise a jour, ni extension signee. Le catalogue public
Spotify et les telechargements YouTube restent des fonctions reseau du logiciel ;
ils ne garantissent pas l'anonymat de l'utilisateur ou du serveur.

### Prerequis

Node >=22.12 pour les outils locaux et tests ; Podman et podman-compose pour la
stack documentee. Le backend embarque Chromium, ffmpeg et yt-dlp. Le navigateur
local Chromium est necessaire aux tests UI. Installer les dependances Node avec
`npm --prefix src ci` (telechargement depuis le registre npm).

### Premier demarrage

1. Copier `.env.example` en `.env`, remplacer chaque indication descriptive par
   une valeur adaptee (ou laisser vide les options inutilisees), puis executer
   `chmod 600 .env`.
2. Choisir `YOUPLAYER_ADMIN_PSEUDO` et un mot de passe d'au moins 12 caracteres.
3. Renseigner `YOUPLAYER_SESSION_SECRET` avec une valeur aleatoire forte. Pour
   generer une valeur : `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`.
4. Renseigner `YOUPLAYER_YOUTUBE_API_KEY` uniquement si la recherche/import API
   YouTube est souhaitee. Les valeurs vides restent indiquees non configurees.
5. Pour OAuth Spotify facultatif, renseigner client ID, client secret, URI de
   retour enregistree et un secret `YOUPLAYER_SPOTIFY_TOKEN_SECRET` distinct.
   Le catalogue Spotify public ne requiert pas de compte personnel.
6. Executer `node scripts/update-service.mjs init` pour preparer uniquement les
   dossiers locaux de communication (aucun depot distant ni cle configuree).
7. Lancer `podman-compose -p youplayer-server up -d --build` et ouvrir
   `https://localhost:8443`. Le certificat genere est autosigne pour localhost.
8. Creer les comptes user depuis Admin. Les comptes, playlists et connexions
   chiffrees sont conserves dans un volume prive ; les sessions utilisent Redis.

Le bootstrap ne remplace pas un compte existant. Retirer les identifiants de
bootstrap de `.env` une fois le premier administrateur cree. Les services et
volumes sont dans le projet Compose `youplayer-server` ; conserver ce nom pour
les outils d'exploitation. Configurer un domaine et un certificat public avant
un usage distant. Aucun lancement ou deploiement n'est automatique au clonage.

### Creer les identifiants API

Remplacer les indications de `.env.example` par tes propres valeurs uniquement
dans `.env`. Les comptes admin affichent leur configuration ; la connexion
personnelle Spotify est reservee aux comptes user.

#### Spotify : `YOUPLAYER_SPOTIFY_CLIENT_ID`

Cette configuration concerne l'OAuth Spotify facultatif. Le catalogue public
fonctionne sans ces identifiants ; les playlists personnelles du WebPlayer
utilisent toujours le pont d'extension.

1. Se connecter au [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   avec un compte Spotify, puis choisir **Create app**.
2. Donner un nom et une description a l'application, selectionner **Web API**
   si demande et accepter les conditions de Spotify.
3. Dans les parametres de l'application (**Settings**), enregistrer une
   **Redirect URI** correspondant au serveur, par exemple
   `https://musique.example.com/auth/spotify/callback`.
4. Copier le **Client ID** dans `YOUPLAYER_SPOTIFY_CLIENT_ID`, puis afficher le
   **Client Secret** et le copier dans `YOUPLAYER_SPOTIFY_CLIENT_SECRET`.
5. Mettre exactement la meme URI dans `YOUPLAYER_SPOTIFY_REDIRECT_URI`.
   Generer aussi un secret de chiffrement distinct pour
   `YOUPLAYER_SPOTIFY_TOKEN_SECRET` avec la commande aleatoire du premier demarrage.

Exemple descriptif a adapter dans `.env` :

```dotenv
YOUPLAYER_SPOTIFY_CLIENT_ID="Client ID affiche dans le Dashboard Spotify"
YOUPLAYER_SPOTIFY_CLIENT_SECRET="Client Secret de cette meme application"
YOUPLAYER_SPOTIFY_REDIRECT_URI="https://musique.example.com/auth/spotify/callback"
YOUPLAYER_SPOTIFY_TOKEN_SECRET="CHANGE_ME : secret aleatoire de 32 caracteres minimum"
```

Spotify exige HTTPS hors adresse loopback et refuse `localhost` comme URI de
retour. Pour un essai local, enregistrer
`https://127.0.0.1:8443/auth/spotify/callback` et ouvrir YouPlayer sur
`https://127.0.0.1:8443` afin de conserver le meme hote de session. Domaine, port,
chemin et barre finale doivent correspondre a l'URI enregistree.
Voir les [parametres des applications](https://developer.spotify.com/documentation/web-api/concepts/apps)
et les [regles des URI de retour](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).

#### YouTube : `YOUPLAYER_YOUTUBE_API_KEY`

1. Ouvrir la [console Google Cloud](https://console.cloud.google.com/) avec un
   compte Google, puis creer ou selectionner un projet.
2. Aller dans **API et services > Bibliotheque**, rechercher
   **YouTube Data API v3**, puis cliquer sur **Activer**.
3. Aller dans **API et services > Identifiants**, puis choisir
   **Creer des identifiants > Cle API**.
4. Dans les parametres de la cle, choisir **Restrictions relatives aux API**,
   puis limiter son usage a **YouTube Data API v3** et enregistrer.
5. Copier la cle obtenue dans `YOUPLAYER_YOUTUBE_API_KEY` de `.env`.

```dotenv
YOUPLAYER_YOUTUBE_API_KEY="Cle API obtenue dans le projet Google Cloud"
```

Les requetes partent du backend. Si une restriction d'application est ajoutee,
utiliser l'adresse IP publique de sortie du serveur, plutot qu'un referent de
site web ou une IP locale. Les quotas se consultent dans la console Google Cloud.
Cette cle sert a la recherche et aux imports via l'API YouTube ; aucun client
OAuth Google n'est necessaire pour ces requetes publiques.
Voir le [demarrage YouTube Data API](https://developers.google.com/youtube/v3/getting-started),
la [creation des identifiants](https://developers.google.com/youtube/registering_an_application)
et les [restrictions des cles API](https://docs.cloud.google.com/docs/authentication/api-keys).

Apres modification de `.env`, recreer le backend pour appliquer les variables :

```bash
podman-compose -p youplayer-server up -d --force-recreate backend
```

Garder les valeurs reelles dans `.env`, exclu de Git ; ne pas les recopier dans
le README ou `.env.example`.

### Etat des connexions dans Admin

Le panneau **Connexions aux services** distingue l'API YouTube, le catalogue public
Spotify et les identifiants OAuth Spotify. A l'ouverture, il affiche la
configuration et les derniers resultats conserves par le serveur, sans appel
externe. Cliquer sur **Verifier les connexions** lance les controles et affiche
la date du dernier test : accessible, non configuree, acces refuse, quota depasse,
delai depasse ou indisponible. Apres un redemarrage, les resultats sont a verifier
de nouveau.

Les controles utilisent uniquement des ressources publiques et les identifiants
d'application configures, jamais les playlists ou comptes personnels. La sonde
YouTube utilise `videos.list` (1 unite de quota selon la
[documentation Google](https://developers.google.com/youtube/v3/docs/videos/list)).
Spotify public verifie l'obtention d'une session invitee ; OAuth verifie un
[jeton d'application](https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow),
pas l'URI de retour ou les autorisations d'un utilisateur. Une sonde reussie
ne garantit pas toutes les recherches ni la lecture des medias.

Les appels sont limites dans le temps et les resultats reutilises pendant
30 secondes ; les controles repetes sont limites par le serveur. Les cles,
jetons et erreurs brutes ne sont jamais retournes a l'interface. Le compte admin
reste reserve a la gestion. Les mises a jour ont leur propre etat dans le panneau
voisin ; aucun compte musical n'est necessaire pour ces controles.

### Tests

`npm --prefix src test` execute les tests serveur, frontend et Chromium avec des
fixtures synthetiques. Les tests du pont d'extension sont ignores si ses sources
ne sont pas fournies explicitement par `YOUPLAYER_EXTENSION_DIR`. Ces sources
ne font pas partie du serveur. Les autres tests ne doivent pas etre declares
valides lorsqu'ils sont ignores faute de navigateur ou de serveur localhost.

### Tests automatiques sur GitHub (CI)

Le workflow [.github/workflows/ci.yml](.github/workflows/ci.yml) lance les tests
Node et navigateur pour chaque push de branche, chaque pull request et a la demande
via **Actions > Tests YouPlayer > Run workflow**. Il utilise Node 24 et installe
Chrome for Testing avec ses dependances systeme sur un runner Ubuntu temporaire.
Si le navigateur ou le serveur de test ne demarre pas, la CI echoue au lieu
d'ignorer les tests UI. Les tests du pont externe restent ignores sans ses sources.

Aucune cle Spotify/YouTube, aucun `.env` et aucun secret GitHub ne sont necessaires
pour ce workflow. Les tests utilisent des donnees synthetiques et des reponses
simulees pour les integrations. L'installation des dependances telecharge des
paquets npm et le navigateur. La CI ne modifie aucun serveur en service.

Apres les tests, le controle **Stack Docker HTTPS** construit les vrais
Dockerfiles et demarre backend, frontend et Redis. Un compte admin et des secrets
aleatoires sont generes dans un fichier temporaire, sans secret GitHub requis.
La CI attend les sondes de sante, puis teste HTTPS, la connexion admin, la session
Redis, les controles d'acces et la deconnexion. Les integrations Spotify/YouTube
reelles ne sont pas configurees dans cette stack ; leurs cas sont testes avec
reponses simulees dans la suite precedente. Le certificat est autosigne pour ce
test local. Les conteneurs et volumes de test sont supprimes a la fin du job.

Pour l'activer, committer les fichiers puis pousser le depot sur GitHub. Les
resultats apparaissent dans l'onglet **Actions** et dans les pull requests.
Dans les regles de protection de la branche, rendre les controles **Tests Node et
Chromium** et **Stack Docker HTTPS** obligatoires si les fusions doivent etre bloquees en cas d'echec.
Le workflow `release.yml` est distinct : il publie des releases sur les tags `v*`
et necessite sa propre cle de signature, comme explique dans [UPDATES.md](UPDATES.md).

Documentation : [tests Node sur GitHub Actions](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs)
et [installation du navigateur Puppeteer](https://pptr.dev/browsers-api).

### Extension Spotify facultative

Le pont navigateur reste pris en charge pour les playlists personnelles. Aucun
XPI ni depot voisin n'est fourni ou selectionne automatiquement. Installer
separement une extension compatible, puis associer l'origine HTTPS exacte de
YouPlayer depuis son popup. Le bearer reste dans l'extension.

Pour construire un paquet depuis des sources compatibles : definir
`YOUPLAYER_EXTENSION_DIR`, puis utiliser `npm --prefix src run extension:build`.
Le paquet genere reste ignore par Git. Sa signature et sa distribution sont
une etape distincte. Il peut etre copie dans `src/downloads/` avant construction
de l'image frontend ; aucune installation n'est proposee par defaut.

### Exploitation et mises a jour

Les releases officielles sont publiees sur
[RaliteJ/YouPlayer_Server](https://github.com/RaliteJ/YouPlayer_Server/releases).
Voir [PRODUCTION.md](PRODUCTION.md) et [UPDATES.md](UPDATES.md). Ne jamais partager
`.env`, `.updates/`, les sauvegardes, journaux, medias ou donnees des utilisateurs.
La copie publique doit conserver seulement des exemples descriptifs sans valeurs personnelles.
