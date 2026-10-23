# YouPlayer Server

Serveur musical personnel et auto-hébergé pour réunir YouTube, Spotify et vos
fichiers audio dans une seule interface web.

## 📋 Sommaire

- [✨ Ce que vous pouvez faire](#ce-que-vous-pouvez-faire)
- [🖼️ Aperçu](#aperçu)
- [📦 Installation](#installation)
- [🚀 Premier démarrage](#premier-démarrage)
- [🔄 Mise à jour](#mise-à-jour)
- [🛠️ Développement](#développement)
- [📚 Documentation](#documentation)
- [📄 Licence](#licence)
- [⚠️ Avertissement](#avertissement)

## Ce que vous pouvez faire

- rechercher de la musique sur YouTube et Spotify ;
- créer des playlists et ajouter vos fichiers audio ;
- retrouver votre file et votre position de lecture sur un autre appareil ;
- passer automatiquement les passages non musicaux YouTube avec SponsorBlock ;
- gérer plusieurs comptes, chacun avec sa bibliothèque privée.

Spotify fournit des références musicales. La disponibilité d'un titre sur Spotify
ne garantit pas qu'une source audio correspondante sera trouvée.

## Aperçu

![Bibliothèque YouPlayer](images/page_user.png)

<details>
<summary>Voir les autres écrans</summary>

### Recherche YouTube

![Recherche YouTube](images/youtube.png)

### Recherche Spotify

![Recherche Spotify](images/spotify.png)

### Lecture en cours

![Lecture en cours](images/lecture_en_cours.png)

### Import d'un fichier audio

![Import d'un fichier audio](images/importlovcal.png)

### Paramètres utilisateur

![Paramètres utilisateur](images/pram_user.png)

</details>

## Installation

YouPlayer fonctionne sur Linux AMD64 ou ARM64 avec :

- Podman et `podman-compose` ; ou
- Docker Engine et le plugin `docker compose`.

Node.js, npm et Go ne sont pas nécessaires.

1. Téléchargez `youplayer-install.tar.gz` et `SHA256SUMS` depuis la même
   [release officielle](https://github.com/RaliteJ/YouPlayer_Server/releases).
2. Dans un dossier vide et permanent, exécutez :

```bash
sha256sum -c SHA256SUMS
mkdir youplayer
tar -xzf youplayer-install.tar.gz -C youplayer
cd youplayer
./install.sh podman
```

Avec Docker, remplacez la dernière commande par `./install.sh docker`.

L'installateur demande le compte administrateur, génère les secrets, télécharge
les images puis démarre les services. N'utilisez pas `sudo` et n'installez pas
YouPlayer dans `/tmp`.

Le guide complet des prérequis et du dépannage se trouve dans [INSTALL.md](INSTALL.md).

## Premier démarrage

1. Ouvrez `https://ADRESSE_DU_SERVEUR:8443`.
2. Connectez-vous avec le compte **admin** créé pendant l'installation.
3. Créez un compte **user** depuis l'administration.
4. Utilisez ce compte **user** pour écouter de la musique.

Le certificat initial est autosigné : votre navigateur peut afficher un
avertissement. Configurez un domaine et un certificat valide avant d'exposer le
serveur sur Internet.

Les intégrations YouTube et Spotify sont facultatives et se configurent dans
`.env`. Ne partagez jamais ce fichier, les journaux, les sauvegardes ou les données
des utilisateurs.

## Mise à jour

Pour une installation issue d'une release :

1. ouvrez **Admin → Intégrations → Version du serveur** ;
2. cliquez sur **Vérifier les nouvelles releases** ;
3. vérifiez la version proposée, puis cliquez sur **Installer la version**.

Rien n'est vérifié ni installé automatiquement. Ne lancez jamais `down -v` : cette
commande supprime les volumes. Consultez [UPDATES.md](UPDATES.md) avant une mise à
jour ou une récupération.

## Développement

Un clone Git sert au développement ; `install.sh` fonctionne uniquement depuis
l'archive d'une release officielle.

```bash
test -f .env || cp .env.example .env
# Remplacez ensuite les valeurs descriptives de .env.
podman-compose -p youplayer-server up -d --build
```

L'interface locale est disponible sur <https://localhost:8443>.

Pour installer les dépendances et lancer les tests :

```bash
npm --prefix src ci
npm --prefix src test
```

## Documentation

- [Installation](INSTALL.md)
- [Mises à jour et récupération](UPDATES.md)
- [Exploitation, sauvegarde et restauration](PRODUCTION.md)
- [Règles de contribution](AGENTS.md)

## Licence

Le code de YouPlayer Server est distribué sous licence
[GNU AGPL version 3](LICENSE). Toute version modifiée accessible à des utilisateurs
par un réseau doit leur permettre d'obtenir son code source correspondant.

Copyright © 2026 RaliteJ.

Cette licence ne couvre pas les marques, pochettes, médias et autres contenus de
tiers affichés par les services musicaux ou dans les captures d'écran.

## Avertissement

YouPlayer Server est créé et maintenu par [RaliteJ](https://github.com/RaliteJ).
Il est fourni sans garantie et n'est ni affilié, ni approuvé, ni sponsorisé par
Spotify, YouTube ou Google.

Vous restez responsable du respect de la loi, du droit d'auteur et des conditions
d'utilisation des services tiers.
