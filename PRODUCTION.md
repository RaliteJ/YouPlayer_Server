# Exploitation du serveur

Les commandes s'executent depuis ce depot, avec le meme compte Podman utilisateur.
Le nom Compose documente est `youplayer-server`. Aucun service de supervision
ou de sauvegarde automatique n'est fourni ou active.

## Validation et lancement

Configurer `.env` selon README.md, puis executer :

```bash
node scripts/production.mjs preflight
podman-compose -p youplayer-server up -d --build
```

Le preflight rapporte des booleens, pas les valeurs des secrets. Il valide la
configuration initiale ; il ne teste pas Spotify, YouTube ou le certificat public.
Le proxy sert HTTPS sur 8443 ; `/health/live` et `/health/ready` sont les sondes.
Verifier connexion, persistance et lecture apres installation. Un essai Chromium
en onglet masque ne prouve pas la lecture ecran verrouille sur appareil physique.

## Sauvegarde et restauration

```bash
node scripts/production.mjs backup --maintenance
node scripts/production.mjs verify-backup DOSSIER
node scripts/production.mjs restore DOSSIER
```

La maintenance interrompt temporairement les services utilisant les donnees.
Les sauvegardes contiennent `.env` et les donnees privees : les garder hors Git
et de toute distribution. La restauration cree de nouveaux volumes et un nouvel
override Compose ; elle n'ecrase pas les donnees courantes. Verifier la copie
restauree avant de la selectionner. Ne pas utiliser `down -v` pour une mise a jour.

## Controle manuel

`node scripts/production.mjs monitor` controle la sante, l'espace disque et
l'age des sauvegardes. Executer cette commande volontairement ; aucun controle
periodique n'est installe par le depot.

## Sources et images

`node scripts/production.mjs release VERSION` archive les sources locales sans
`.env`, donnees, sauvegardes, dependances installees ou configuration d'updates.
Le manifeste conserve la provenance du nouveau depot Git. Inspecter toute
distribution avant partage : des fichiers ajoutes ulterieurement peuvent etre
prives meme s'ils ne portent pas un nom reserve.

`scripts/build-update-release.mjs` construit une release signee (voir UPDATES.md).
L'outil avance `scripts/prepare-release.mjs VERSION` exige les images
`localhost/youplayer-server-{backend,frontend}:production-check`, les conteneurs courants
du projet `youplayer-server` et des images compatibles de retour arriere taguees
`production-previous`. Aucun de ces artefacts n'est preconfigure ou fourni.

Le controle ephemere `scripts/verify-production-stack.mjs --public-media`
contacte Spotify/YouTube avec un fixture public. Ne l'executer que pour un essai
reseau volontaire ; les tests unitaires utilisent des donnees simulees.


## Image sans Chromium

L'image backend de release conserve FFmpeg et yt-dlp mais n'embarque plus Chromium.
Les fonctions Spotify courantes utilisent HTTP ou le pont du navigateur utilisateur.
`YOUPLAYER_SPOTIFY_BROWSER_ENABLED=false` desactive explicitement les diagnostics
sandbox et la capture Pathfinder par navigateur dans cette image ; le statut
sandbox l'indique et les sondes retournent un message explicite sans lancer de navigateur.

Puppeteer reste installe pour conserver l'outillage existant. Les tests navigateur
et les diagnostics sur une installation de developpement necessitent leur propre
Chromium et, si besoin, `PUPPETEER_EXECUTABLE_PATH`. Activer le flag seul n'installe
aucun navigateur. Aucun navigateur n'est telecharge pendant la construction.
