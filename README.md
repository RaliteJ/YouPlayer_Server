<div align="center">

# 🎵 YouPlayer

### Votre musique. Vos playlists. Votre serveur.

Un lecteur musical personnel pour réunir YouTube, Spotify et vos fichiers audio dans une même interface web.

**Auto-hébergé · Interface web · Node.js**

Découvrir (\#a-propos) · Fonctionnalités (\#fonctionnalites) · Prise en main (\#prise-en-main) · Contribuer (\#contribuer)
</div>

***

## 📋 Sommaire



- [👀 À propos](#a-propos)
  - [❓ Pourquoi](#pourquoi)
- [✨ Fonctionnalités](fonctionnalités)
- [🚀 Prise en main](#prise-en-main)
- [📦 Installation](#installation)
- [🔑 Configuration](#configuration)
- [🚀 Lancement](#lancement)
- [🧩 Organisation du projet](#organisation)
- [👷 Contribuer](#contribuer)
- [⚠️ Disclaimer](#disclamer)

<a id="a-propos"></a>

## 👀 À propos

YouPlayer rassemble la recherche musicale, les playlists et la lecture audio dans une interface pensée pour un usage personnel.

Le serveur gère les sources musicales et la file de lecture. Le navigateur permet de parcourir votre bibliothèque et de piloter le lecteur.

<a id="pourquoi"></a>

### ❓ Pourquoi YouPlayer ?

Un morceau trouvé sur YouTube, une référence Spotify, un fichier audio conservé sur votre machine : votre musique peut venir de plusieurs endroits.

YouPlayer permet de les réunir dans des playlists et de les écouter depuis un même lecteur.

<a id="fonctionnalites"></a>

## ✨ Fonctionnalités


|  | Fonction | Description |
|:---:|:---|:---|
| 🎵 | **Un lecteur commun** | Lecture, pause, morceau précédent et suivant depuis une barre de contrôle commune. |
| 📚 | **Playlists** | Création de playlists, ajout de morceaux et sélection des collections à écouter. |
| 🔎 | **Recherche musicale** | Recherche de titres depuis les vues YouTube et Spotify. |
| 💿 | **Fichiers locaux** | Ajout de fichiers audio depuis votre appareil. |
| 🔀 | **Lecture aléatoire** | Mélange de la sélection pour varier l'ordre des morceaux. |
| 🌐 | **Interface web** | Navigation entre bibliothèque, lecteur et paramètres depuis le navigateur. |

<a id="prise-en-main"></a>

## 🚀 Prise en main

Une fois votre instance configurée et démarrée :

1. **Choisissez votre musique** dans les vues YouTube, Spotify ou fichiers locaux.
2. **Ajoutez les morceaux à une playlist**, existante ou créée pour l'occasion.
3. **Sélectionnez les playlists à écouter** depuis l'accueil.
4. **Lancez la lecture** et utilisez les contrôles pour parcourir votre sélection.

Le projet associe un serveur Node.js et une interface HTML, CSS et JavaScript. La configuration du serveur, des chemins de fichiers et de l'adresse API doit correspondre à votre environnement avant le lancement.




<a id="installation"></a>

## 📦 Installation

### ⚙️ Prérequis

- Podman et Podman Compose.
- OpenSSL pour générer les secrets.
- Node.js ≥ 22.12 pour exécuter les outils Node hors conteneurs.

Les commandes suivantes s’exécutent à la racine du projet, dans le dossier contenant `docker-compose.yml`.

<a id="configuration"></a>

### 🔑 Configuration

Pour une première installation, créez votre configuration locale sans écraser un fichier existant :

```bash
test -f .env || cp .env.example .env
chmod 600 .env
```

Dans `.env`, configurez au minimum :

```env
YOUPLAYER_ADMIN_PSEUDO=votre_pseudo
YOUPLAYER_ADMIN_PASSWORD=votre_mot_de_passe
YOUPLAYER_SESSION_SECRET=votre_secret_aleatoire
```

Choisissez un mot de passe administrateur d’au moins **12 caractères**. Générez le secret de session avec :

```bash
openssl rand -base64 32
```

Copiez le résultat dans `YOUPLAYER_SESSION_SECRET`. Conservez `.env` hors Git.

<a id="lancement"></a>

### 🚀 Lancement

Construisez et démarrez les services :

```bash
podman-compose -f docker-compose.yml up -d --build
```

Ouvrez ensuite :

```text
https://localhost:8443
```

Le certificat local peut déclencher un avertissement du navigateur.

### 👤 Première connexion

Connectez-vous avec le compte administrateur défini dans `.env`.

Les comptes **admin** servent à la gestion. Créez un compte **user** depuis Admin pour accéder au lecteur et aux playlists.

Les comptes et playlists sont conservés dans le volume `youplayer_data`, et les sessions dans `redis_data`. Sauvegardez ces volumes avant une mise à jour et évitez les commandes qui les suppriment.


<a id="organisation"></a>

## 🧩 Organisation du projet

| Élément | Rôle |
|:---|:---|
| `index.html` | Structure de l'interface et des vues. |
| `style.css` | Apparence du lecteur, de la navigation et des playlists. |
| `app.js` | Interactions du navigateur avec le lecteur et le serveur. |
| `server/` | Serveur Express, gestion de la lecture et intégrations musicales. |
| `spotify/` | Ressources liées à l'intégration Spotify. |
| `package.json` | Dépendances Node.js du projet. |

<a id="contribuer"></a>


## 👷 Contribuer

Les améliorations de l'interface, de la documentation et de la fiabilité du lecteur sont les bienvenues.

Pour une modification, décrivez :

- le problème rencontré ;
- le comportement attendu ;
- les vérifications effectuées.

Utilisez des exemples fictifs : les comptes, clés, playlists personnelles et fichiers audio privés doivent rester hors des contributions.

***
<div align="center">

**YouPlayer — un seul lecteur pour votre musique.**

<a id="disclaimer"></a>


## ⚠️ Disclaimer

YouPlayer Server was created and is maintained by RaliteJ.

Copyright © 2026 RaliteJ. All rights reserved.

This project is provided “as is”, without warranties of any kind. It is not affiliated with, endorsed by, or sponsored by Spotify, YouTube, or Google.

Users are responsible for complying with applicable laws, copyright requirements, and the terms of service of any third-party platforms they access. This project does not grant permission to download, copy, or distribute copyrighted content.