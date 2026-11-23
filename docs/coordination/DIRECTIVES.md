# Directives communes

Décisions utilisateur à appliquer dans les trois projets, sous réserve de ses instructions plus récentes et des permissions effectives.

## Travail et périmètre

- Vérifier le dossier réel, la branche et `git status` avant toute modification ; conserver les changements préexistants, y compris les fichiers non suivis et les artefacts signés.
- Respecter la portée de la demande : lecture seule pour un diagnostic ou une lecture demandée, corrections uniquement lorsqu'elles sont autorisées. Cette organisation autorise la coopération dans les trois projets, pas la modification automatique de tout leur contenu.
- Un responsable travaille dans son dépôt attribué. Lecture des interfaces des deux autres dépôts permise pour l'intégration. L'ingénieur coordonne sans provoquer de changements concurrents sur un même fichier.
- Ne pas explorer d'autres projets applicatifs. Les consignes/outils système et les documentations officielles nécessaires restent soumis aux permissions de la session.
- Utiliser Graphify existant comme carte, confirmer les chemins et symboles dans le code actuel ; ne pas reconstruire le graphe sans besoin ou demande.
- Privilégier le plus petit changement complet, les helpers existants et les dépendances déjà installées. Aucun refactoring, wrapper ou option pour un besoin hypothétique.
- Répondre en français, brièvement, avec résultat, preuves et limites ; distinguer une cause identifiée d'une correction réellement appliquée.

## Confidentialité et comptes

- Aucun cookie, mot de passe, bearer, access token ou refresh token Spotify n'atteint le serveur YouPlayer : ni API, session serveur, base, fichier, URL, journal, sauvegarde ou trace d'erreur, même chiffré.
- Les cookies Spotify restent dans le profil local du navigateur ou de GeckoView ; les jetons restent dans le stockage éphémère local du Bridge. Le renouvellement s'effectue côté client.
- Le serveur peut conserver les playlists importées et leurs métadonnées normalisées (titres, artistes, identifiants et liens). Cette autorisation ne couvre pas les identifiants de connexion.
- L'authentification YouPlayer demeure distincte : sessions et mots de passe hachés YouPlayer restent gérés côté serveur, avec isolation par utilisateur, contrôle d'origine et flux privés par session.
- Les comptes admin servent uniquement à la gestion ; les parcours musicaux utilisent un compte user. Ne pas contourner cette séparation pour afficher les réglages Spotify.
- Ne jamais inclure secrets, configuration locale, comptes réels, médias ou journaux dans Git, rapports ou paquets. Utiliser des données synthétiques pour les vérifications locales.
- L'ancien OAuth serveur persistant des jetons est un écart connu à traiter (`YP-003`). Ne pas l'étendre ni prétendre qu'il respecte cette règle. Toute suppression de données existantes doit être préparée séparément et explicitement autorisée.

## Expérience attendue

- L'APK est le client d'un serveur YouPlayer réel : adresse HTTPS et connexion YouPlayer mémorisées, bibliothèque et lecture fournies par ce serveur. Pas de serveur autonome caché dans l'APK ni de site YouPlayer embarqué à synchroniser.
- Spotify demande une première connexion sur chaque appareil ; restaurer ensuite automatiquement la session locale si elle est valide. Afficher une demande de connexion uniquement lorsque Spotify exige une intervention. Ne pas promettre une connexion partagée avec l'application Spotify officielle.
- Aucune extension à installer manuellement dans l'APK : son Bridge est embarqué. Ne pas imposer Firefox externe, un onglet externe permanent ou une configuration développeur aux utilisateurs Android.
- L'extension navigateur reste un produit distinct. Un parcours ordinateur ne doit pas être présenté comme une solution Chrome Android. La capacité d'un navigateur doit être vérifiée avant de promettre son support.
- Les erreurs doivent proposer l'action utile ; ne pas présenter une session expirée ou un démarrage lent comme une extension absente.

## Audio et paroles

- Coordonner les deux éléments audio persistants pour les fondus ; seul `ended` du lecteur actif avance automatiquement la file. Préserver les sessions, reprises et commandes existantes.
- Paroles synchronisées Spotify/Musixmatch uniquement. Aucun retour aux sous-titres YouTube, à la transcription, à LRCLIB ou lyrics.ovh sans instruction explicite.
- Ne pas changer le moteur de lecture Android ou réintroduire l'ancien service natif comme effet secondaire d'une correction Spotify. Toute promesse d'écran verrouillé, de Bluetooth ou de lecture physique exige un essai adapté.

## Livraison et validation

- Ajouter chaque nouvelle ressource publique du serveur à sa liste d'autorisation explicite ; vérifier aussi son inclusion dans les images et les paquets concernés.
- Tester les vrais points d'entrée et des cas d'échec pertinents. Séparer tests unitaires/synthétiques, navigateur, téléphone physique, build, artefact signé/publié et déploiement réellement servi.
- Un code source corrigé n'est pas automatiquement une image reconstruite ou un serveur mis à jour. Un tag ou un workflow lancé n'est pas une publication réussie.
- Ne pas installer d'APK, signer, taguer, publier, déployer ou modifier une stack/volume actif sans instruction correspondante. Les intégrations externes doivent être configurées et activées explicitement.
- Laisser les push à l'utilisateur. Ne pas lire ni utiliser ses identifiants GitHub. Ne pas stage des fichiers sans demande ni committer automatiquement.
- Ne jamais supprimer les volumes pour une mise à jour normale ; préserver les données lors d'une désinstallation par défaut.
