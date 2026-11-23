# Suivi commun YouPlayer

Seul `integration_engineer` consolide ce fichier. Une attribution ne lance pas un travail et ne vaut pas autorisation d'installer, publier ou déployer. Les responsables conservent les modifications préexistantes.

État initial : 15 novembre 2026, sources locales modifiées dans les trois dépôts ; détails de provenance dans compatibility.json. Les tâches de fonctionnement ci-dessous sont préparées, pas implémentées par la mise en place de l'organisation.

| ID | Priorité | Responsable(s) | État | Dépendances et résultat attendu |
| --- | --- | --- | --- | --- |
| YP-000 | P0 | integration_engineer | Validé localement | Directives, rôles, contrats et suivi préparés pour les trois projets ; liens, empreintes et préservation vérifiés. |
| YP-001 | P1 | pm_app, pm_bridge | En pause | Chantier APK suspendu à la demande de l'utilisateur le 16 novembre 2026 ; correctif Android préparé en patch, non appliqué. |
| YP-002 | P1 | pm_server, pm_app, pm_bridge | En cours | États web et navigateur possibles ; restauration et transport Android en pause avec le chantier APK. Contrat additif défini ; un auteur par dépôt. |
| YP-003 | P1 | pm_server | En cours | Retrait des parcours OAuth personnels déjà présent dans les modifications locales ; vérification des routes, comptes et stores, sans suppression des données historiques. |
| YP-004 | P2 | pm_bridge, pm_app, pm_server | En cours | Trois modules partagés divergent depuis le relevé initial : client, pathfinder et session. Comparaison possible ; propagation vers l'App en pause. |

## YP-001 — Restaurer Spotify dans l'APK

- Cible : l'utilisateur ouvre son serveur mémorisé, se connecte à YouPlayer si nécessaire et retrouve sa musique ; si une session Spotify locale valide existe, l'application tente de la restaurer sans imposer l'ouverture manuelle de l'écran Spotify.
- App : `SpotifyBridge.java`, `SpotifyActivity.java`, `MainActivity.java`, adaptateur WebView et tests concernés. Bridge : cycle de session/renouvellement partagé et tests si une évolution est nécessaire.
- Conserver le bearer éphémère et les cookies locaux ; ne pas persister un jeton sur serveur ou ajouter un jeton durable pour éviter de restaurer la session.
- Ne montrer la connexion interactive que si nécessaire ; maintenir l'action de connexion de première utilisation et la déconnexion explicite.
- Critères : premier login, fermeture/réouverture, processus recréé, token expiré avec cookies valides, vraie session expirée, réseau perdu puis restauré, retour sans interruption de lecture, deux utilisateurs isolés et changement de serveur.
- Preuves : tests de cycle de vie/protocole ciblés puis parcours Spotify réel sur téléphone. Aucun de ces essais physiques n'est acquis par ce tableau.

## YP-002 — États et messages cohérents

- Sources : `src/spotify-explorer.js`, `src/spotify-browser-bridge.js`, `src/index.html`, `SpotifyBridge.java`, `SpotifyActivity.java`, `android-background.js` et adaptateur WebView.
- Distinguer l'absence réelle du Bridge, le démarrage, la restauration, la connexion requise, l'état prêt et une panne récupérable ; définir la représentation minimale dans le contrat avant modification.
- Préserver le protocole des extensions existantes. Aucun nouveau champ obligatoire pour les anciens clients sans transition.
- Vérifier le statut web à 5 s face à la file native à 65 s ; un timeout ne doit pas devenir une preuve d'extension absente.
- Le retour automatique doit aussi être défini lorsque la session est déjà connectée à l'ouverture. Ne pas supprimer un parcours de changement de compte sans examiner son usage.
- Critères : Android sans message d'installation d'extension, Firefox/Chromium conservés, erreurs actionnables et répétition sans accumulation de requêtes.

## YP-003 — Confidentialité du serveur

- Examiner les routes OAuth, le catalogue et les stores actuels avec des fixtures synthétiques ; distinguer les jetons personnels historiques des mécanismes anonymes/applicatifs éventuellement encore présents.
- Proposer comment garantir qu'aucun cookie ou jeton de connexion Spotify n'est reçu ou stocké, tout en conservant comptes YouPlayer, playlists importées et métadonnées.
- Ne pas lire de secrets ni de dumps pour établir le diagnostic. Une migration ou suppression de données utilisateur est une opération séparée, préparée et explicitement autorisée.
- Critères : flux HTTP pertinents, sessions, stockage et erreurs vérifiés sans jeton ; authentification et isolation YouPlayer intactes. La conformité de production exige une vérification distincte.

## Mise à jour et reprise

États utilisables : À diagnostiquer, Préparé, En cours, En pause (demande utilisateur), À intégrer, Validé localement, À vérifier sur téléphone, Bloqué (raison explicite), Terminé selon critères. Une étape partielle ne clôt pas la tâche.

16 novembre 2026 — chantier APK mis en pause à la demande de l'utilisateur. Aucun travail App, build, installation ou essai sur téléphone jusqu'à reprise explicite. Les tâches Server et Bridge indépendantes restent ouvertes ; vérifier leurs interfaces avec l'APK avant toute livraison qui le concerne.

16 novembre 2026 — Server YP-003 : URL de playlist Spotify canonisée avant import et audit ; paramètres et fragments écartés, hôtes imités refusés. Tests ciblés import/auth : 50/50 passent. Les stores conservent encore les données OAuth historiques ; leur migration ou suppression reste hors de ce correctif.

16 novembre 2026 — Server YP-003 : lectures ordinaires de comptes PostgreSQL découplées de la table Spotify historique ; aucun jeton chiffré chargé par `findUserByPseudo` ou `findUserById`. Tests ciblés : 53/53 passent. Les anciennes méthodes de stockage et les données antérieures restent à traiter séparément.

Pour chaque tâche active, consigner seulement : date, responsable actif, fichiers réservés, résultat, commandes et résultats utiles, validations restantes et prochaine action. Relever branche et HEAD avec les modifications locales à la reprise. Pas de logs sensibles.

## Preuves de mise en place

## Reprise du 15 novembre 2026 — vérification des changements existants

- Responsable actif : `integration_engineer`, auteur unique des documents communs. Server : branche `feat/extension/chrome_extension`, HEAD `e5989cbb6f3d01accce342501b4cd1c35e6c69da` ; App : `dev`, HEAD `4520b20481642404dcd7ca3acdaad22c99b7d38c` ; Bridge : `fix/update/extension`, HEAD `fe1349dc9c674b0ad2049747ae976eb724edff92`. Les trois arbres sont modifiés ; conservation du travail préexistant.
- `pm_server` : réserve les corrections applicatives et tests Server liés aux états Spotify (YP-002), à l'isolation des comptes et au retrait OAuth déjà présent (YP-003). Examiner les appelants, compléter seulement les lacunes et valider localement.
- `pm_app` : examine en lecture seule la restauration locale et le transport Android (YP-001/002), les tests existants et le correctif minimum restant. Les permissions actuelles ne permettent pas d'écriture dans App sans escalade explicite.
- `pm_bridge` : examine en lecture seule le cycle de session, le protocole et la concordance des modules App/ZIP Server (YP-004). Aucun nouveau paquet ni changement partagé sans besoin établi.
- Contrat : champs optionnels de restauration et état local d'indisponibilité définis dans CONTRACTS.md avant complément des corrections. Aucun changement obligatoire du protocole navigateur.
- Vérifications et résultats de cette reprise : en cours. Aucun test réel Spotify, installation, commit, push ou déploiement autorisé par cette reprise.

### Preuves initiales YP-000

15 novembre 2026 :

- Les responsabilités des quatre rôles sont décrites dans ROLES.md.
- Les liens Markdown locaux de la coordination ont été vérifiés lors de sa mise en place.
- Les six modules partagés sont identiques dans Bridge, App et le ZIP serveur. Empreintes et versions des sources consignées dans compatibility.json, avec mention des arbres de travail modifiés.
- Contrôle SHA-256 de 273 fichiers existants hors graphe : aucun fichier applicatif modifié par la mise en place. Les documents de coordination nouvellement créés sont exclus de la comparaison lors de leur mise à jour finale.
- `git diff --check` exécuté sans erreur dans les trois dépôts. Aucun staging effectué à cette étape.
- Trois intervenants ont relu les responsabilités Bridge, App et Server en lecture seule.
- Aucune correction YP-001/002/003, compilation, installation APK, signature, publication, push, déploiement ou vérification Spotify réelle effectuée pendant YP-000.

La structure documentaire est prête ; la relecture déléguée ne prouve pas le fonctionnement des parcours applicatifs.
