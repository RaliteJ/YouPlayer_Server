# Installation depuis Git

Le serveur se construit depuis les sources. L’ancien installateur d’archives
signées et le service de mise à jour ont été retirés.

## Première installation Podman

Prérequis : Linux, Git, Bash, OpenSSL, curl, Podman et podman-compose.
Node.js est fourni par les images ; il n’est pas nécessaire sur l’hôte.
Utiliser le compte Podman utilisateur, sans sudo. Le build nécessite un accès
réseau et de l’espace pour les images et les dépendances.

```bash
git clone https://github.com/RaliteJ/YouPlayer_Server.git
cd YouPlayer_Server
./install.sh
```

Le script vérifie les outils, demande un pseudo et un mot de passe admin,
génère les secrets dans `.env` avec des permissions privées, construit les
images et démarre backend, frontend et Redis. Il embarque le commit Git si les
sources sont propres ; sinon la version est signalée comme inconnue. Il attend que la route HTTPS de disponibilité réponde.
Les valeurs de `.env`, y compris les `$`, sont transmises littéralement à Compose.
Un fichier `.env` existant est conservé et validé. Aucun compte existant n’est
remplacé. Une stack déjà présente est refusée : ce script sert à l’installation,
pas aux mises à jour.

Ouvrir **https://ADRESSE_DU_SERVEUR:8443**, se connecter avec le compte admin,
puis créer un compte **user** pour écouter la musique. Le certificat initial
est autosigné ; configurer un certificat adapté avant un usage public.

En cas d’échec, les données sont conservées. Le diagnostic de construction et
de démarrage reste privé dans `.updates/host/install.log`. Vérifier la stack avant de
recommencer : si des conteneurs existent, utiliser les commandes manuelles de
[UPDATES.md](UPDATES.md). Aucun nettoyage destructif n’est effectué.

## Installation manuelle et données

Le [guide technique](README.md#installation-et-build) décrit la configuration
et les commandes Compose manuelles. Le Compose fourni cible Podman ; pour une
installation Docker existante, conserver son Compose adapté, son projet et ses
montages. Ne pas changer de moteur pendant une mise à jour.

Conserver `.env`, `src/playlists/`, `src/local_song/` et les volumes des comptes,
sessions Redis et certificats. `.updates/` reste utilisé par l’audit de sécurité
facultatif ; il ne faut pas le supprimer lors de cette migration.

## Mises à jour

L’utilisateur exécute lui-même `git pull --ff-only`, puis construit et redémarre
les conteneurs. Voir [UPDATES.md](UPDATES.md). Aucun service ni bouton Admin
n’installe de nouvelle version. La vérification informative du backend reste
explicite et indépendante de l’installation.
