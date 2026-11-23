# Contrats d'intégration

Référence de comportement des trois projets. Distinguer les interfaces existantes ci-dessous de l'expérience cible ; la présence du document ne prouve pas sa validation sur appareil.

## Répartition des données

| Donnée | Emplacement autorisé |
| --- | --- |
| Comptes et sessions YouPlayer | Serveur, avec session du client et isolation utilisateur |
| Playlists importées, titres, artistes, références Spotify | Serveur, par utilisateur |
| Cookies et identifiants de connexion Spotify | Profil local du client uniquement |
| Access token / refresh token / bearer Spotify | Stockage éphémère local du Bridge uniquement ; jamais transmis au serveur |
| Résultats normalisés Spotify | Réponses au client YouPlayer ; import serveur uniquement via les routes métier autorisées |

Le serveur n'est pas le relais de la session personnelle Spotify. Le Bridge interroge Spotify côté client ; la page reçoit uniquement les données utiles et peut importer les titres dans la bibliothèque. Les cookies du navigateur système, de GeckoView et de l'application Spotify officielle ne sont pas présumés partagés.

## Protocole de la page YouPlayer

Sources à vérifier à chaque changement : Server `src/spotify-browser-bridge.js`, Bridge `browser-extension/background-runtime.js`, App `app/src/main/assets/spotify/webview-bridge.js` et `app/src/main/java/privateplayer/youplayer/SpotifyBridgePolicy.java`.

```json
{"source":"youplayer-app","requestId":"identifiant-unique","action":"status"}
{"source":"youplayer-spotify-extension","requestId":"identifiant-unique","ok":true,"data":{}}
{"source":"youplayer-spotify-extension","requestId":"identifiant-unique","ok":false,"error":"message utilisateur sans secret"}
```

- `requestId` assure la corrélation ; format commun accepté par Android : 8 à 128 caractères alphanumériques ou tirets. Ignorer les réponses tardives et celles d'une page quittée.
- Valider l'origine exacte, le port, la fenêtre émettrice et le frame principal. Pas d'iframe ou d'URL arbitraire pour accéder au transport natif.
- Garder les actions publiques compatibles : `status`, `search`, `get-album`, `get-artist`, `get-lyrics`, `get-playlists`, `get-playlist`, `open-spotify`.
- Charges utiles publiques actuelles : `query`, `limit`, `offset`, `albumId`, `artistId`, `trackId`, `playlistId`, selon la commande ; aucune charge utile de connexion Spotify.
- `status` indique notamment `installed`, `enabled` lorsqu'il est fourni, `spotifyTabOpen`, `spotifyContentReady`, `tokenCaptured`, `authenticated`, `anonymous`, `expiresAt`. Ces informations ne contiennent pas le jeton ; `enabled` absent ne signifie pas désactivé.
- Sur Android, `open-spotify` ouvre `SpotifyActivity` côté Java ; les autres commandes publiques sont transmises au Bridge embarqué. `android-reset` est natif uniquement ; `spotify-token` est une capture interne réservée à Spotify, jamais une commande de la page YouPlayer.
- Le retour Android utilise `youplayer-spotify-return` puis `App.spotifyExplorer.refreshConnection()` sans recharger le lecteur.
- Délais actuels côté web : statut 5 s, ouverture 3 s, paroles 15 s, recherche/album/artiste/playlists 30 s, contenu playlist 60 s. Le délai natif maximal est 65 s. Réconcilier les états de démarrage et d'erreur avant d'allonger des délais sans mesure (`YP-002`).

Ces enveloppes n'ont pas encore de numéro de protocole négocié. Garder les évolutions additives compatibles ; une rupture exige une stratégie de transition, une matrice testée et une attribution dans TASKS.md. Ne pas introduire de nouveau champ de version sans nécessité concrète.

### États de restauration (YP-001/002)

- Le champ optionnel `restoring: true` indique une tentative locale en cours ; son absence reste compatible avec les extensions existantes. Il ne contient aucune donnée de connexion et ne signifie pas que l'utilisateur doit ouvrir Spotify.
- La page représente une erreur de transport par `unavailable: true` et `installed: null`. Un délai dépassé ne prouve pas l'absence du Bridge. Seul un statut explicite peut annoncer son absence.
- Sur Android, le Bridge est embarqué : les messages proposent la connexion dans l'application ou une nouvelle tentative, jamais l'installation d'une extension. Une session prête conserve les champs existants `authenticated` et `tokenCaptured`.
- Un changement de compte YouPlayer invalide les réponses et l'affichage issus du compte précédent. Le retour de Spotify rafraîchit la connexion sans recharger les deux lecteurs audio.

## Sources et distribution

- Source des modules communs : `YouPlayer-Spotify-Bridge/browser-extension/spotify-{client,pathfinder,normalizers,session,content,hook}.js`.
- Copie embarquée Android : mêmes fichiers dans `YouPlayer_App/app/src/main/assets/spotify-extension/`. `PROVENANCE.md` consigne leur origine. Les adaptations `android-background.js`, manifeste Android et transports Java restent propres à App.
- Paquet web : Server `scripts/build-spotify-extension.mjs` lit une source indiquée explicitement par `YOUPLAYER_EXTENSION_DIR`. Aucun dépôt voisin sélectionné implicitement à l'exécution de l'application.
- Le ZIP Chromium distribué est `src/downloads/youplayer-spotify-bridge-chromium.zip`. Vérifier son contenu, l'autorisation de la route et son inclusion dans l'image frontend.
- Un paquet Firefox non signé, une extension Firefox signée, un ZIP Chromium et un APK sont des artefacts distincts. Vérifier chacun avant publication ; ne pas remplacer silencieusement un XPI signé par un build local.
- Android est un client du site distant ; pas de duplication du site dans l'APK. Un changement du site peut affecter des APK déjà installés : vérifier les versions précédentes pertinentes ou noter explicitement la limite.

Le relevé [compatibility.json](compatibility.json) contient les versions des sources et les SHA-256 observés des six modules. Les HEAD ne suffisent pas car les arbres de travail sont modifiés. Toute mise à jour doit préciser la provenance et les contrôles réellement effectués, sans requalifier le relevé en validation physique.

## Écarts connus

- `YP-001` : session GeckoView créée seulement lors de l'ouverture de l'écran Spotify ; restauration transparente cible non réalisée.
- `YP-002` : des erreurs sont traduites en « extension absente » ; textes navigateur inadaptés à l'APK et reconnexion du port natif à revoir.
- `YP-003` : les routes OAuth personnelles sont désactivées. Les stores ne proposent plus de méthodes pour gérer les connexions Spotify et le diagnostic serveur utilise un navigateur temporaire anonyme. Les anciens champs des fichiers de comptes et les anciennes tables restent sur disque. La vérification de la configuration et des données de production reste à faire.
- `YP-004` : les copies des six modules sont actuellement identiques ; leur propagation doit rester contrôlée à chaque changement.
