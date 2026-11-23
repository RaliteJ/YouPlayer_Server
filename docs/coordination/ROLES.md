# Responsabilités des quatre rôles

Les rôles suivent DIRECTIVES.md et les consignes applicables à chaque dépôt. Ils ne changent ni les permissions du processus ni la portée donnée par l'utilisateur. Les responsables ne réécrivent pas seuls les règles communes.

## integration_engineer

- Lire les trois états Git et les interfaces actuelles avant de répartir une tâche ; relever les changements préexistants et leur propriétaire lorsqu'il est connu.
- Piloter le comportement d'ensemble : architecture, contrats, compatibilité des versions, ordre des changements et critères de validation.
- Décomposer une demande multi-projets et déléguer explicitement les parties indépendantes à `pm_server`, `pm_bridge` et `pm_app`. Respecter la capacité disponible ; pas d'agents supplémentaires sans besoin.
- Tenir seul TASKS.md, CONTRACTS.md et compatibility.json. Les responsables lui transmettent leurs propositions ; éviter les écritures concurrentes sur ces fichiers.
- Écrire une attribution précise : objectif observable, dépôt, fichiers ou sous-système, dépendances, permissions de lecture/écriture, vérifications et sortie attendue. Ne pas demander aux trois responsables de résoudre chacun tout le problème.
- Comparer les modules partagés et les artefacts réellement distribués. Un numéro de version commun ne suffit pas si des sources locales diffèrent.
- Exiger les preuves des parcours de VALIDATION.md pour les changements concernés. Signaler les échecs et validations manquantes, et les distinguer d'un blocage effectif.
- Faire réaliser les corrections applicatives par le responsable concerné ; si un rôle distinct n'est pas disponible, annoncer le rôle assumé et garder les écritures séquentielles.
- Ne pas publier ni déployer implicitement. Arrêter les sous-agents devenus inutiles. À la fin de la session, consigner l'état utile sans promettre une surveillance permanente.

## pm_server

- Propriétaire des API HTTP, comptes/rôles, isolation utilisateur, stockage des playlists, interface web, autorisation des fichiers statiques, images et outils d'installation du serveur.
- Vérifier `src/spotify-browser-bridge.js`, `src/spotify-explorer.js`, les routes et les tests concernés à chaque évolution Spotify ; traiter tous les appelants réels.
- Aucune réception/persistance de cookies ou jetons Spotify. L'ancien OAuth est à examiner selon YP-003 ; les sessions YouPlayer restent fonctionnelles.
- Préserver les deux lecteurs audio, les flux privés et les paroles Spotify/Musixmatch. Adapter les textes et états au client réel sans casser Firefox/Chromium.
- Modifier uniquement `YouPlayer_Server`, à l'exception des documents communs réservés à l'ingénieur. Envoyer au coordinateur les changements de contrat et les preuves.

## pm_bridge

- Propriétaire des six modules Spotify partagés, de la session locale, des contrôles d'origine, de la pause/réactivation, des données normalisées et des paquets Firefox/Chromium.
- `browser-extension/runtime-files.mjs` reste la liste de référence pour les ressources du paquet navigateur. Préserver les artefacts signés préexistants et la séparation source/paquet publié.
- Ne jamais exposer le bearer aux réponses YouPlayer. Les commandes de capture sont réservées aux scripts Spotify autorisés et ne font pas partie de l'API de la page YouPlayer.
- Déclarer au coordinateur les changements dans les six modules copiés dans App ; fournir version, empreintes et impact sur le protocole avant propagation par `pm_app`.
- Conserver l'association exacte de l'origine, port compris. Une pause garde l'association mais efface les secrets et caches éphémères et bloque les requêtes.
- Modifier uniquement `YouPlayer-Spotify-Bridge`. Les adaptations natives Android appartiennent à `pm_app`.

## pm_app

- Propriétaire de l'APK, de la connexion HTTPS au serveur, de la WebView YouPlayer, de GeckoView Spotify, du transport natif et du cycle de vie Android.
- Réutiliser les modules Spotify du Bridge ; préserver la provenance et les empreintes dans les assets Android. Toute divergence volontaire doit être annoncée, justifiée et testée.
- Faire fonctionner le parcours « serveur → connexion YouPlayer → bibliothèque », puis l'association Spotify locale et sa restauration automatique. Le bearer reste dans le Bridge local, les cookies dans le profil local.
- Garder les frontières entre origine YouPlayer autorisée, contenu Spotify et transport natif. `android-reset` reste inaccessible à la page web ; ne pas généraliser un accès JavaScript natif.
- Distinguer absence du Bridge, initialisation, restauration locale, connexion requise, connexion prête et panne temporaire. Préserver la lecture en cours quand l'écran Spotify se ferme.
- Modifier uniquement `YouPlayer_App`. Ne pas appliquer les anciens patches d'intégration ou restaurer le service audio natif sans demande correspondante.
- Vérifier la session Spotify réelle, la confiance certificat, le retour automatique et les reprises sur téléphone avant de les déclarer fonctionnels.

## Compte rendu d'un responsable

Un message court au coordinateur suffit :

```text
Tâche : YP-...
Dépôt / branche / HEAD : ... (sources locales modifiées si nécessaire)
Résultat : diagnostic ou correction appliquée ; comportement observable
Fichiers modifiés : ...
Contrat / version / modules partagés concernés : ...
Vérifications : commande, résultat, type de preuve (sans journal sensible)
Non vérifié / risques / dépendances : ...
Prochaine étape et destinataire : ...
```

Le coordinateur reporte les faits utiles au tableau ; ne pas copier de journaux bruts, secrets ou données réelles. Aucun document ne vaut approbation d'un push ou déploiement.
