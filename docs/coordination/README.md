# Coordination YouPlayer

Point d'entrée commun aux trois projets. Cette organisation prépare les rôles et le travail ; elle ne lance aucun service, agent permanent, déploiement ou correction Spotify.

## Les quatre rôles

| Rôle | Projet et responsabilité |
| --- | --- |
| `pm_server` | `YouPlayer_Server` : API, comptes, bibliothèque et interface web distante |
| `pm_bridge` | `YouPlayer-Spotify-Bridge` : session Spotify locale, protocole et paquets navigateur |
| `pm_app` | `YouPlayer_App` : client Android, session YouPlayer et Bridge embarqué |
| `integration_engineer` | Contrats communs, découpage des tâches et validation des parcours entre projets |

Les chemins sont relatifs aux dépôts frères ; le nom Android est exactement `YouPlayer_App` (majuscules comprises). La référence commune réside ici pour rester versionnée sans créer de quatrième dépôt.

## Documents à lire

- [DIRECTIVES.md](DIRECTIVES.md) : règles communes et décisions utilisateur.
- [ROLES.md](ROLES.md) : périmètres, délégation et compte rendu attendu.
- [CONTRACTS.md](CONTRACTS.md) : échanges, données et responsabilités des composants.
- [TASKS.md](TASKS.md) : tâches attribuées et dépendances ; seul l'ingénieur y consolide les résultats.
- [VALIDATION.md](VALIDATION.md) : commandes ciblées, parcours réels et conditions de livraison.
- [compatibility.json](compatibility.json) : versions et empreintes observées des sources locales ; ce relevé n'est pas une certification ni un état déployé.

## Utilisation de la coordination

Les rôles et leurs responsabilités sont décrits dans [ROLES.md](ROLES.md). Pour lancer une tâche depuis Server :

> Prends le rôle integration_engineer. Lis docs/coordination, prépare YP-001 et délègue aux responsables concernés. Préserve les modifications existantes et ne publie rien.

Depuis App :

> Prends le rôle pm_app. Lis les consignes du dépôt et la coordination commune, puis traite la partie Android de YP-001 et rapporte les preuves à l'ingénieur.

Ces exemples servent à lancer une nouvelle mission ; les tâches du tableau ne démarrent pas simplement parce que ce fichier est lu. Les responsabilités peuvent être assumées successivement si plusieurs intervenants ne sont pas disponibles.

La session principale peut prendre le rôle ingénieur et déléguer à trois responsables, selon la capacité réelle du client. Les documents persistent ; les processus d'agents doivent être lancés dans une session active. Il n'y a pas de surveillance automatique ou de conversation permanente entre projets.

Si un dépôt frère manque, le signaler et demander son emplacement avant une tâche qui en dépend ; ne pas chercher dans des dépôts sans rapport ou les cloner implicitement.

## Cycle d'une tâche

1. L'ingénieur relit les directives, les trois états Git et les points d'entrée actuels. Il précise le résultat attendu, les dépôts/fichiers concernés et les critères de validation dans TASKS.md.
2. Chaque responsable lit le code et tous les appelants concernés, puis réalise uniquement la partie attribuée et autorisée. Les analyses indépendantes peuvent être parallèles ; les écritures sur un même fichier sont séquentielles.
3. Chaque responsable rend un compte rendu court : fichiers, contrat touché, vérifications passées/échouées/non exécutées, limites et prochaine étape.
4. L'ingénieur vérifie la compatibilité de l'ensemble, consigne les preuves utiles et les éventuelles divergences de modules. Il distingue code prêt, essais locaux, essai téléphone, publication et déploiement.
5. L'utilisateur conserve les opérations de publication et de push. Recontrôler l'état courant à toute reprise ; un document de suivi n'autorise pas une opération supplémentaire.
