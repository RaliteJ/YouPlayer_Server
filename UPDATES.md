# Mise à jour manuelle

Les mises à jour de YouPlayer sont réalisées par l’utilisateur sur l’hôte.
Il n’y a plus de scripts de mise à jour, de worker ni de commandes dans Admin.
Le contrôle des dépendances dans **Admin → Sécurité** reste indépendant.

## Avant de commencer

Utiliser le dossier de l’installation, le même compte, le même moteur de
conteneurs et le même nom de projet Compose. Les exemples Podman utilisent
`youplayer-server` ; conserver votre nom existant s’il est différent.

Sauvegarder `.env`, les dossiers médias et les volumes persistants selon
[PRODUCTION.md](PRODUCTION.md). Les outils de sauvegarde fournis ciblent Podman ;
sur Docker, utiliser votre procédure de sauvegarde habituelle et vérifier la
restauration. Aucun backup ni rollback ne sera déclenché par la mise à jour.

Arrêter l’ancien worker `node scripts/update-service.mjs run` s’il tourne encore.
S’il avait été configuré dans systemd ou un autre superviseur, désactiver ce
service explicitement avant de continuer. Ne pas supprimer `.updates/` : ce
dossier peut contenir des sauvegardes de diagnostic et l’état de l’audit npm.

## Récupérer les sources

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git pull --ff-only
```

Noter le commit courant pour permettre une récupération manuelle. Examiner les
modifications locales avant le pull ; les sauvegarder ou les intégrer sans
écraser `.env` ni les adaptations Compose. En cas de conflit, de divergence ou
d’absence de branche distante suivie, s’arrêter et résoudre la situation : ne
pas forcer, réinitialiser ou changer de branche automatiquement.

## Construire puis redémarrer

**Exécuter les commandes dans l’ordre et s’arrêter à la première erreur.**
Le pull ne met à jour que les sources ; le code exécuté est dans les images.
La construction précède le redémarrage pour laisser les anciens services en
place si elle échoue.

Pour identifier correctement la version installée, les commandes ci-dessous
intègrent le commit Git à l’image. Les exécuter seulement avec des sources
propres (`git status --short`). Si vous construisez des modifications non
commitées, utiliser `YOUPLAYER_BUILD_COMMIT=unknown` à la place du SHA : un commit
ne représente pas ces modifications.

Pour Podman :

```bash
podman-compose --env-file .env -p youplayer-server build --build-arg "YOUPLAYER_BUILD_COMMIT=$(git rev-parse HEAD)"
podman-compose --env-file .env -p youplayer-server up -d --no-build
podman-compose --env-file .env -p youplayer-server ps
```

Certaines anciennes versions de Podman Compose réinterprètent les `$` des mots
de passe. Dans ce cas, utiliser ce bloc à la place des deux premières commandes :
il charge les valeurs littéralement et s’arrête si la construction échoue.

```bash
node --input-type=module <<'NODE'
import { spawnSync, execFileSync } from 'node:child_process';
import { composeEnvironment } from './scripts/install.mjs';
const env = composeEnvironment(process.cwd(), 'youplayer-server');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
for (const args of [['build', '--build-arg', `YOUPLAYER_BUILD_COMMIT=${commit}`], ['up', '-d', '--no-build']]) {
  const result = spawnSync('podman-compose', [
    '--env-file', '/dev/null', '-p', 'youplayer-server', ...args
  ], { env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
NODE
```

Pour une installation **Docker Compose existante**, conserver son fichier
Compose adapté à Docker (celui du dépôt contient des options Podman), son
projet, ses overrides et son mode d’accès au daemon :

```bash
docker compose --env-file .env -p NOM_DU_PROJET_EXISTANT build --build-arg "YOUPLAYER_BUILD_COMMIT=$(git rev-parse HEAD)"
docker compose --env-file .env -p NOM_DU_PROJET_EXISTANT up -d --no-build
docker compose --env-file .env -p NOM_DU_PROJET_EXISTANT ps
```

Le redémarrage interrompt momentanément la lecture. Ne pas utiliser `down -v`,
`volume rm` ou supprimer les dossiers persistants : ces opérations ne sont pas
nécessaires pour une mise à jour.

## Vérifier et récupérer en cas d’échec

```bash
curl --fail --silent --show-error --insecure https://127.0.0.1:8443/health/ready
```

`--insecure` ne sert ici que pour la sonde locale avec le certificat autosigné.
Vérifier ensuite la connexion, les comptes, les playlists et la lecture.
Si la santé échoue, consulter les journaux localement et ne pas supprimer les
volumes. Le retour au commit noté et la reconstruction sont manuels ; ils ne
restaurent pas les données ni n’annulent une migration. Vérifier la compatibilité
des données et utiliser la sauvegarde si nécessaire.

## Anciennes installations sans Git

Les anciennes archives `youplayer-install.tar.gz` n’ont ni historique Git ni
sources complètes : on ne peut pas y lancer `git pull`. Sauvegarder l’installation
et préparer un clone séparé. Avant toute activation, reporter la configuration
et les médias de manière privée et contrôler les chemins de montage absolus,
le projet et les volumes existants. Ne pas lancer une nouvelle stack en parallèle
sur le même port ou les mêmes données. Cette migration est manuelle ; un clone
ne doit pas être traité comme une installation neuve avec des volumes vides.

## Afficher la version et vérifier les releases

Dans **Admin → Intégrations**, le panneau **Version du serveur** affiche le
commit installé et la dernière release connue. Le bouton **Vérifier les nouvelles
releases** lance la comparaison. L’ouverture du panneau lit seulement le résultat
local, sans contacter GitHub.

### API du backend

- `GET /admin/releases` renvoie l’état local et le dernier résultat en mémoire,
  sans appel externe.
- `POST /admin/releases/check` déclenche une vérification explicite auprès de
  GitHub. Une session admin et une origine de confiance sont requises. Le corps
  de la requête ne permet ni de choisir un dépôt ni de lancer une commande.

Le backend compare le commit intégré à l’image à la dernière release stable de
`RaliteJ/YouPlayer_Server`, via l’[API de comparaison GitHub](https://docs.github.com/en/rest/commits/commits#compare-two-commits).
Il renvoie `localCommit`, `latestRelease` (tag et lien), `checkedAt`, `state` et
`updateAvailable`. Les états de comparaison sont `release_ahead`, `up_to_date`,
`local_ahead` et `diverged`. `updateAvailable` est vrai uniquement pour
`release_ahead`, faux pour `up_to_date` ou `local_ahead`, et nul si la réponse
ne permet pas de conclure (version inconnue, divergence, quota, réseau ou aucune
release). Un ancien build sans commit embarqué reste `local_unknown`.

Les appels concurrents sont regroupés et le résultat est conservé cinq minutes,
y compris en cas d’erreur. Aucun appel n’a lieu au démarrage. Seuls le dépôt et
le SHA local sont transmis à GitHub ; ni configuration, ni compte, ni média.
Cette vérification n’installe rien et ne déclenche aucun pull ou redémarrage.
L’interface ne dispose pas de bouton d’installation.
