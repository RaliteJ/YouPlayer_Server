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
Compose, Python 3 (PyYAML) et flock sont requis. Le backend ne recoit pas de socket Podman.

```bash
node scripts/update-service.mjs init
node scripts/update-service.mjs configure --repository https://github.com/RaliteJ/YouPlayer_Server \
  --public-key keys/release-public-key.pem
```

Le fichier `keys/release-public-key.pem` contient la cle publique du signataire
officiel. Verifier la provenance du code hote avant de configurer cette confiance.
Pour un autre signataire, utiliser sa cle publique verifiee et adapter le chemin.
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

## Controles avant installation et reprise apres echec

Le service cible exclusivement le projet `youplayer-server`. Le fichier `.env`
doit contenir une configuration de production valide ; si `COMPOSE_PROJECT_NAME`
est renseigne, sa valeur doit etre `youplayer-server`. Chaque commande Compose
recoit le chemin absolu de ce fichier et son nom explicite, depuis le dossier
du projet. L'option `--project-directory`, absente d'anciennes versions de
`podman-compose`, n'est pas necessaire.
Les variables `YOUPLAYER_*` exportees dans le terminal ne remplacent pas celles
de l'installation. Le service ne modifie pas `.env`.

Avant de telecharger les images, le service controle les noms et labels des trois
conteneurs, les trois volumes du projet, les reseaux `private` et `sessions`, les
dossiers montes et le port 8443. Une autre stack partageant ce port ou ces donnees,
meme arretee, bloque l'installation avant la sauvegarde et la recreation.
Les installations qui utilisent une autre topologie sont refusees ; le service
ne devine pas leur correspondance avec les volumes attendus.
Une modification de `.env`, de Compose ou des images pendant l'operation annule
la bascule. Les empreintes de configuration restent dans la transaction privee.

Compose sert uniquement a resoudre la configuration via `config`. Le service
valide les options prises en charge et refuse une configuration inconnue avant
le telechargement : il ne supprime pas silencieusement une option de securite.
La configuration courante du depot est prise en charge ; une personnalisation
doit etre ajoutee et testee explicitement avant installation.

La recreation utilise directement `podman create`, `stop`, `rm`, `rename` et
`start`. Les deux candidats sont crees et controles a l'arret avant de couper
les services existants. Le frontend puis le backend sont arretes proprement et
retires par leurs identifiants verifies. Les candidats prennent ensuite leurs
noms habituels et demarrent backend puis frontend. Redis conserve son identite ;
les volumes et reseaux existants sont reutilises. Les alias DNS, controles de
sante, espaces utilisateur, options de securite et montages prives sont conserves
depuis la configuration validee. Aucun `compose run`, `up`, build ou pull n'est
execute pendant cette bascule. Cela evite la recreation globale que certaines
versions de Podman Compose effectuent sur un changement de configuration.

Les variables des conteneurs passent par des fichiers temporaires en mode 0600
dans un dossier prive de l'hote, jamais par les arguments de commande ou l'API.
Ces fichiers sont retires apres la tentative. Les candidats abandonnes ne sont
retires a la reprise que si leur identite, leurs labels et leurs montages
correspondent a cette transaction. Un echec de preparation qui laisse les anciens
conteneurs intacts ne provoque pas leur recreation inutile.
Les images de backend/frontend sont controlees apres recreation, puis le service
attend leur sante et la reponse HTTPS de `/health/ready`. Les deux variantes Podman
`State.Health` et `State.Healthcheck` sont acceptees. La version n'est enregistree
comme installee qu'apres ces controles. Les tags locaux correspondent a ceux de
Compose : `localhost/youplayer-server-backend:latest` et
`localhost/youplayer-server-frontend:latest`.
Compose impose `pull_policy: never` pour ces deux images locales : aucun registre
sur `localhost` n'est necessaire. Avant une recreation ou un retour arriere, le
service verifie que les deux identifiants d'image sont presents localement.
L'archive importe des tags de release ; elle ne garantit pas la presence du tag
`latest`. Une commande Compose lancee seule apres un echec ne remplace donc pas
la procedure d'installation ou de reprise du service.

Admin distingue le remplacement des conteneurs, la verification du demarrage
et l'enregistrement de la version. Un echec affiche un code traduit et son etape :
depot/release introuvable, signature invalide, conflit de projets, configuration,
images inattendues, delai depasse ou sante insuffisante. Les diagnostics codes
sont conserves dans `.updates/host/failure.json`. La sortie d'une commande hote en
echec est conservee uniquement dans `.updates/host/last-command.log` (mode 0600),
jamais dans l'API. Ce journal peut contenir des informations privees : le consulter
sur l'hote, ne pas publier ni partager sa sortie brute.

Le retour arriere est declare reussi seulement apres controle des anciennes
images, des ressources et de la sante. S'il echoue, `transaction.json` et
`job.json` sont conserves, et toute nouvelle installation est bloquee. Un
redemarrage explicite du service tente de reprendre le retour arriere avec les
ressources enregistrees. Les anciennes transactions sans cette description
des ressources demandent une verification manuelle sur l'hote : aucune ressource
n'est supprimee ou devinee automatiquement.

Un verrou systeme sur `.updates/host/service.flock` empeche deux services hote de
traiter la meme installation et se libere apres un arret brutal. Ne jamais
supprimer ce fichier pendant qu'un service tourne : cela permettrait de verrouiller
un autre inode. Un ancien `service.lock/pid` actif est respecte pendant la migration.
Les enregistrements de transaction et de version sont synchronises sur disque.
Ne pas supprimer la transaction ou les verrous de sauvegarde pour contourner un echec.
Les commandes ont un delai maximal ; sur l'hote POSIX, un depassement arrete
aussi leurs sous-processus avant tout retour arriere, afin qu'une ancienne
commande Compose ne continue pas a modifier les conteneurs pendant la reprise.

Pour migrer, installer le code hote mis a jour, y compris
`scripts/update-deployment.mjs`, `scripts/update-container-plan.mjs`,
`scripts/update-compose-config.py` et `src/server/update-control.js`, puis arreter
l'ancien processus de mise a jour et relancer `node scripts/update-service.mjs run`.
Le frontend/backend doivent egalement utiliser cette version du code pour afficher
les nouveaux diagnostics. Une mise a jour d'images ne remplace pas les scripts hote.
Si deux stacks existent deja, les identifier par leurs labels, montages et volumes
avant toute suppression ou nouvelle tentative. Ces changements locaux ne nettoient
pas une installation distante.

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

Le scenario local `node scripts/verify-update-stack.mjs /tmp/ARCHIVE_IMAGES_BASE.tar`
attend une archive Podman contenant les images backend/frontend `latest` et
Redis du Compose. Il cree un stockage Podman et des donnees synthetiques dans
un dossier prive de `/tmp`, puis nettoie ses conteneurs. Les artefacts restent
dans ce dossier pour diagnostic. Il ne reutilise pas les volumes de l'installation.
Python 3, PyYAML, podman-compose et Podman avec reseau rootless sont necessaires.

Ce scenario execute une verification Admin sans recreation, une installation
d'archive signee, un retour arriere apres echec de sante et une reprise avec
frontend absent. Il controle HTTPS, session utilisateur, playlist, fichiers,
volumes et identite Redis. Les releases et le transport sont synthetiques et
locaux ; les healthchecks reels sont executes explicitement, sans minuteur
systemd dans l'environnement isole. Cela ne valide pas une release distante,
le transport registre ou un deploiement en production.

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
Cette valeur est affichee comme **estimee** tant que les IDs des images actives
ne sont pas confirmes par l'enregistrement d'une installation reussie. Lors d'une
verification, si les images en cours correspondent exactement au manifeste signe,
le service peut confirmer la version deja installee sans recreation de conteneurs.
Un enregistrement confirme conserve les controles de version et de sequence
contre le retour a une ancienne release.
Le panneau **Admin > Mises a jour** propose **Verifier les mises a jour**, puis
**Installer et redemarrer** seulement lorsqu'une version admissible est disponible.
