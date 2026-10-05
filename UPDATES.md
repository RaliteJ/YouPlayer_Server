# Mises a jour depuis Admin

Les mises a jour sont facultatives et non configurees au clonage. Le panneau Admin
affiche cet etat tant qu'aucun service et depot de releases n'ont ete configures.
Le service utilisateur telecharge des releases GitHub/GitLab publiques, verifie
Ed25519 et SHA-256, sauvegarde les donnees et remplace backend/frontend. Il garde
les volumes et tente un retour arriere si la verification de sante echoue.
L'installation est explicite et interrompt temporairement la lecture.

Le depot officiel des releases est [RaliteJ/YouPlayer_Server](https://github.com/RaliteJ/YouPlayer_Server/releases).

## Preparation volontaire

Utiliser le compte Podman de l'installation, sans sudo. Node >=22.12, Podman
Compose et flock sont requis. Le backend ne recoit pas de socket Podman.

```bash
node scripts/update-service.mjs init
node scripts/update-service.mjs configure --repository https://github.com/RaliteJ/YouPlayer_Server \
  --public-key .updates/publisher/public-key.pem
```

Installer la cle publique Ed25519 fournie par le signataire des releases dans
`.updates/publisher/public-key.pem`, puis executer la commande de configuration.
Ne pas generer une nouvelle paire sur chaque installation : une cle differente
ne pourra pas verifier les releases officielles. Pour un autre depot GitLab,
modifier l'URL et ajouter `--gitlab`. `.updates/` contient les cles, configuration, archives et transactions
privees : ne jamais publier ce dossier. `--from-git` selectionne explicitement
l'origine du nouveau depot ; il ne conserve pas l'origine d'un autre projet.

Apres configuration, lancer explicitement le processus de mise a jour :

```bash
node scripts/update-service.mjs run
```

Ce processus doit rester actif pour traiter les demandes Admin. Il opere sur le
projet Compose `youplayer-server`. Aucun service de lancement automatique n'est
fourni. Une configuration locale seule ne publie pas de release et ne prouve pas
le fonctionnement d'une mise a jour distante.

## Publication volontaire d'une release

Pour le mainteneur uniquement : generer une paire Ed25519 avec
`node scripts/prepare-update.mjs keygen` si aucune cle de signature n'existe encore.
Conserver cette meme cle pour les releases suivantes ; partager uniquement la
cle publique avec les installations. La cle privee sert au secret Actions
`YOUPLAYER_RELEASE_SIGNING_KEY` du depot `RaliteJ/YouPlayer_Server`.

```bash
node scripts/build-update-release.mjs v1.0.0 .updates/publisher/private-key.pem
```

L'outil construit les deux images et prepare `youplayer-images.tar` et
`youplayer-update.json` sous `releases/v1.0.0/update-assets/`. Le manifeste est
signe et associe les IDs des images, leur taille et la somme de l'archive. Publier
ces deux fichiers uniquement apres validation ; ne pas publier la cle privee.

Le workflow `.github/workflows/release.yml` est un modele pour les tags `v*` et
le lancement manuel. Il exige le secret Actions `YOUPLAYER_RELEASE_SIGNING_KEY`,
qui n'est pas fourni. Un push de tag pourra lancer ce workflow si le depot est
heberge sur GitHub et Actions active. Aucun push ni publication n'est effectue
par la preparation locale de cette distribution.

Le format v1 remplace backend/frontend ; il ne migre pas les donnees et ne met
pas a jour automatiquement Redis ou Compose. Conserver des sauvegardes privees
verifiees et des images compatibles de retour arriere.
