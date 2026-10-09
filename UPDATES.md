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

## Transport par couches (registre, schema 2)

Le service accepte aussi un manifeste Ed25519 schema 2. Il contient, pour chacun
des deux services, le depot et le digest SHA-256 du manifeste d'image publie,
ainsi que l'ID local attendu de sa configuration. Ces deux empreintes sont
distinctes. Le service utilise `podman pull --tls-verify=true --policy=always`
avec le digest signe, puis verifie la reference, l'ID et la plateforme avant
toute sauvegarde et tout redemarrage. Podman reutilise les couches presentes
localement ; une couche modifiee est telechargee entierement.

Documentation Podman : [pull par digest](https://docs.podman.io/en/stable/markdown/podman-pull.1.html)
et [digest apres publication](https://docs.podman.io/en/stable/markdown/podman-push.1.html).

### Migration d'une installation existante

Le service hote et `docker-compose.yml` ne sont pas remplaces par une mise a jour
des images. Installer d'abord cette version du code hote et de Compose par
votre procedure habituelle, conserver la configuration privee et redemarrer
le processus `node scripts/update-service.mjs run`. Un ancien service refuse
le schema 2 ; publier une archive schema 1 ne modernise pas ce service hote.

Configurer ensuite explicitement les deux depots autorises (exemples fictifs) :

```bash
node scripts/update-service.mjs configure \
  --repository https://github.com/RaliteJ/YouPlayer_Server \
  --public-key .updates/publisher/public-key.pem \
  --image-repository registry.example.com/equipe/youplayer-backend \
  --image-repository registry.example.com/equipe/youplayer-frontend
```

La commande remplace la configuration precedente : repeter les deux options
pour conserver les deux autorisations. Les anciennes releases schema 1 restent
acceptees ; sans liste explicite, les releases schema 2 sont refusees.
Les telechargements du registre sont effectues par Podman, avec ses mecanismes
TLS et d'authentification, distincts de la liste d'origines des assets Git.
Pour un registre prive, configurer `podman login` ou `REGISTRY_AUTH_FILE` dans
le compte et l'environnement du service hote. Le registre peut deleguer
l'authentification et servir ses blobs depuis un stockage externe selon son
protocole ; la liste autorise les depots d'images, pas chaque hote CDN.

Cette premiere version distribue une seule plateforme par release :
`linux/amd64` ou `linux/arm64`. La plateforme hote doit correspondre. Les index
multiarchitectures ne sont pas produits par cet outil. Redis, Node du service
hote, Compose et les migrations de donnees restent geres separement.

### Construction et publication explicites

Choisir d'abord le registre et la visibilite des depots. Le prefixe suivant
produit les depots `youplayer-backend` et `youplayer-frontend`, ainsi que
`youplayer-backend-cache` et `youplayer-frontend-cache` pour le cache de build.
Ces caches contiennent des etapes de construction et demandent la meme
confidentialite que les images. Podman doit prendre en charge `build --layers
--cache-from --cache-to` et avoir les droits de lecture/ecriture correspondants.

```bash
podman login registry.example.com
node scripts/build-update-release.mjs v1.1.0 .updates/publisher/private-key.pem \
  --registry-prefix registry.example.com/equipe/youplayer
```

**Cette commande publie les images et leur cache dans le registre.** Elle ne
publie pas la release Git. Elle prepare uniquement `youplayer-update.json`
dans `releases/v1.1.0/update-assets/`, sans archive d'images. Publier ce manifeste
sur la release Git du meme tag apres validation. Les tags du registre sont
informatifs : le client recupere exclusivement les digests signes.
Conserver les images de retour arriere et les digests encore references par
les manifests Git ; ne pas les supprimer par une retention trop courte.

Le workflow GitHub conserve le mode archive pour les tags automatiques.
Le lancement **manuel** avec `registry_prefix` non vide active explicitement
la publication par couches et exige les secrets `YOUPLAYER_REGISTRY_USERNAME`
et `YOUPLAYER_REGISTRY_PASSWORD`, en plus de la cle Ed25519. Le compte du
registre doit pouvoir publier les quatre depots, sans droit superflu. Aucune
visibilite publique n'est configuree automatiquement. Eviter de remplacer
une release existante par un autre format : utiliser un nouveau tag.

Le backend copie maintenant les sources avec leur proprietaire, sans recopier
les dependances via un `chown -R` final. Le frontend genere son certificat
autosigne au premier demarrage, dans le volume `frontend_certs`, puis le
reutilise. Ce volume contient une cle privee et entre dans les sauvegardes du
projet ; la restauration reutilise sa copie si elle existe. Une ancienne
sauvegarde sans ce volume provoque la generation d'un nouveau certificat.
Lors de la premiere recreation d'une ancienne installation, le certificat
peut donc changer : verifier la confiance du navigateur ou fournir votre
certificat dans ce volume avant la bascule.

### Validation et limites

Le premier pull et un changement de base/dependances peuvent rester volumineux.
Le cache de build distant aide a reutiliser les couches de dependances entre
les runners CI. Aucun gain chiffre n'est garanti sans mesurer les objets
reellement publies et les transferts d'une installation.

Les tests locaux simulent publication, pull, echec de telechargement,
empreintes incorrectes, plateforme incompatible, liste de depots refusee,
ancienne sequence, reprise et retour arriere. Ils ne prouvent ni une vraie
publication ni le volume reseau economise. Avant diffusion, valider sur une
installation de test : modification frontend seule, backend seul, dependances,
interruption, espace insuffisant, signature invalide et echec de sante. Le
telechargement interrompu est relance ; Podman gere la reutilisation des blobs
deja charges. La transaction de deploiement conserve la reprise et le retour
aux anciennes images. Un retour d'images n'annule pas une migration de donnees
incompatible ; cette version n'en introduit aucune.

Verification locale du 9 octobre 2026 : les 32 tests cibles update/production
passent ; les deux images se construisent et les essais sans reseau confirment
les droits du compte backend et la generation/reutilisation du certificat.
Les tailles locales non compressees sont de 623 147 103 octets (backend) et
71 375 925 octets (frontend). Une variante CSS synthetique conserve 11 des
19 couches frontend ; les couches suivantes sont reconstruites et restent
petites (la copie principale des ressources pese environ 333 ko). Ce constat
porte sur les couches locales, pas sur les octets transferes par un registre.
Le build npm signale une vulnerabilite critique dans les dependances ; son
analyse et sa correction restent distinctes de cette modification du transport.
Aucune release distante, publication d'image ou installation en production
n'a ete effectuee pour cette verification.

La disponibilite exige aussi une version numerique stable strictement superieure
a celle installee (`v1.10.0` > `v1.9.9`), en plus d'une sequence signee croissante
et d'images differentes. Une version egale ou inferieure est refusee avant tout
telechargement, meme avec une sequence plus haute. Les anciens tags `v1` et
`v2` sont interpretes comme `1.0.0` et `2.0.0` ; les prereleases et labels non
numeriques ne sont pas installables. La version installee provient de
`.updates/host/active.json` apres une mise a jour reussie. Au premier lancement,
le service utilise le dernier tag `v*` accessible depuis HEAD, puis la version
de `src/package.json` en l'absence de tag numerique valide. Lors de la migration,
ce checkout doit donc correspondre aux images effectivement installees.
Le panneau **Admin > Mises a jour** propose **Verifier les mises a jour**, puis
**Installer et redemarrer** seulement lorsqu'une version admissible est disponible.
