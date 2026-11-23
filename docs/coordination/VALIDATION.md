# Validation d'ensemble

N'exécuter que les contrôles concernés par la tâche. Les commandes ci-dessous sont des points d'entrée existants, pas une preuve qu'elles ont déjà réussi. Un besoin de permission, SDK, dépendance ou navigateur est rapporté comme tel.

## Contrôles locaux par responsable

Depuis Server :

```sh
node --test --test-isolation=none test/spotify-browser-bridge.test.js test/spotify-explorer.test.js test/spotify-lyrics.test.js
node --test --test-isolation=none --test-name-pattern='settings offer Firefox|Spotify lyrics' test/browser-auth.test.js
```

En cas de modification des routes/comptes : tests HTTP/auth et tests du store concernés ; `npm --prefix src test` pour une validation plus large justifiée. Toute nouvelle ressource publique est vérifiée dans le serveur et dans l'image servie lorsque ce déploiement est autorisé.

Depuis Bridge :

```sh
npm --prefix browser-extension test
```

Un changement de paquet peut justifier `npm --prefix browser-extension run build:all`, après inventaire des artefacts et préservation des fichiers signés. Le build écrit dans `dist/` et ne signe ni ne publie.

Depuis App :

```sh
node --test --test-isolation=none scripts/spotify-bridge.test.mjs
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Les contrôles Gradle nécessitent JDK/SDK et dépendances disponibles et écrivent des sorties de build locales. Une construction d'APK n'autorise pas son installation sur un appareil.

Pour vérifier le paquet Chromium Server contre les sources Bridge, depuis la racine Server :

```sh
YOUPLAYER_EXTENSION_DIR=../../YouPlayer-Spotify-Bridge/browser-extension npm --prefix src run extension:check -- --chromium
```

Le chemin est relatif à `src`, où npm exécute le script. Cette commande suppose que le ZIP existe déjà ; sa reconstruction est une opération distincte.

Comparer les six fichiers partagés à ceux de `app/src/main/assets/spotify-extension/` et les SHA-256 de compatibility.json. Si la source change, reporter l'écart et mettre à jour la copie/provenance seulement dans la tâche autorisée.

## Parcours de référence

| Parcours | Résultat attendu | Preuve nécessaire |
| --- | --- | --- |
| Premier lancement APK | Saisie HTTPS du serveur, login YouPlayer, bibliothèque distante | Test interface et téléphone |
| Première connexion Spotify | Écran intégré, autorisation utilisateur, retour à YouPlayer sans extension manuelle | Vrai compte sur téléphone |
| Relancement avec cookies valides | Tentative de restauration locale automatique ; pas de manipulation répétée | Processus Android recréé sur téléphone |
| Expiration du jeton | Renouvellement local ou demande de connexion justifiée ; pas de jeton envoyé au serveur | Tests synthétiques puis session réelle |
| Perte du réseau / du port natif | Erreur actionnable et reprise ; pas de faux diagnostic « extension absente » | Simulation ciblée puis téléphone |
| Recherche, albums, artistes, playlists, likes | Résultats normalisés, pagination correcte, import utilisateur isolé | Tests ciblés et session réelle |
| Paroles synchronisées | Spotify/Musixmatch ; bearer local ; aucune ancienne route de sous-titres | Tests de protocole et navigateur/téléphone |
| Déconnexion Spotify / changement de compte | Cookies et session locale effacés comme demandé, aucun cache du compte précédent | Tests de séparation puis téléphone |
| Changement de serveur | Origine, confiance certificat et session locale réinitialisées selon le contrat ; pas de partage inter-serveurs | Tests de politique et téléphone |
| Fondus / file / retour Spotify | Deux lecteurs conservés, seul `ended` actif avance, retour sans rechargement intempestif | Navigateur avec audio synthétique ; téléphone pour le rendu réel |
| Mise à jour compatible | Site distant, ancienne version cliente pertinente et nouveaux paquets fonctionnent ensemble | Versions et artefacts exacts, provenance et résultats consignés |

Pour les fonctions en cours (YP-001/002), ce tableau exprime la cible ; ne pas annoncer leur réussite sans les preuves correspondantes.

## Conditions de livraison

- Chaque responsable rapporte les commandes réellement exécutées et leurs résultats, les contrôles sautés et pourquoi.
- L'ingénieur relit les changements de contrat et les copies de modules avant de conclure sur l'ensemble.
- Une validation locale n'implique ni connexion Spotify acceptée, ni lecture audible, ni publication, ni déploiement. Mentionner précisément ces limites.
- Signature, publication de paquets, installation APK, push, tag et mise à jour d'une stack requièrent l'instruction correspondante ; aucune commande de publication n'est déclenchée par cette checklist.
