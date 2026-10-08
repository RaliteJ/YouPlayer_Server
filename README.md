\<div align="center"\>

# 🎵 YouPlayer

### Votre musique. Vos playlists. Votre serveur.

Un lecteur musical personnel pour réunir YouTube, Spotify et vos fichiers audio dans une même interface web.

**Auto-hébergé · Interface web · Node.js**

Découvrir (\#a-propos) · Fonctionnalités (\#fonctionnalites) · Prise en main (\#prise-en-main) · Contribuer (\#contribuer)
\</div\>

***

## 📋 Sommaire

- 👀 À propos (\#a-propos)
- ✨ Fonctionnalités (\#fonctionnalites)
- 🚀 Prise en main (\#prise-en-main)
- 🧩 Organisation du projet (\#organisation)
- 👷 Contribuer (\#contribuer)

\<a id="a-propos"\>\</a\>

## 👀 À propos

YouPlayer rassemble la recherche musicale, les playlists et la lecture audio dans une interface pensée pour un usage personnel.

Le serveur gère les sources musicales et la file de lecture. Le navigateur permet de parcourir votre bibliothèque et de piloter le lecteur.

### ❓ Pourquoi YouPlayer ?

Un morceau trouvé sur YouTube, une référence Spotify, un fichier audio conservé sur votre machine : votre musique peut venir de plusieurs endroits.

YouPlayer permet de les réunir dans des playlists et de les écouter depuis un même lecteur.

\<a id="fonctionnalites"\>\</a\>

## ✨ Fonctionnalités


|  | Fonction | Description |
|:---:|:---|:---|
| 🎵 | **Un lecteur commun** | Lecture, pause, morceau précédent et suivant depuis une barre de contrôle commune. |
| 📚 | **Playlists** | Création de playlists, ajout de morceaux et sélection des collections à écouter. |
| 🔎 | **Recherche musicale** | Recherche de titres depuis les vues YouTube et Spotify. |
| 💿 | **Fichiers locaux** | Ajout de fichiers audio depuis votre appareil. |
| 🔀 | **Lecture aléatoire** | Mélange de la sélection pour varier l'ordre des morceaux. |
| 🌐 | **Interface web** | Navigation entre bibliothèque, lecteur et paramètres depuis le navigateur. |

\<a id="prise-en-main"\>\</a\>

## 🚀 Prise en main

Une fois votre instance configurée et démarrée :

1. **Choisissez votre musique** dans les vues YouTube, Spotify ou fichiers locaux.
2. **Ajoutez les morceaux à une playlist**, existante ou créée pour l'occasion.
3. **Sélectionnez les playlists à écouter** depuis l'accueil.
4. **Lancez la lecture** et utilisez les contrôles pour parcourir votre sélection.

Le projet associe un serveur Node.js et une interface HTML, CSS et JavaScript. La configuration du serveur, des chemins de fichiers et de l'adresse API doit correspondre à votre environnement avant le lancement.

\<a id="organisation"\>\</a\>

## 🧩 Organisation du projet

| Élément | Rôle |
|:---|:---|
| `index.html` | Structure de l'interface et des vues. |
| `style.css` | Apparence du lecteur, de la navigation et des playlists. |
| `app.js` | Interactions du navigateur avec le lecteur et le serveur. |
| `server/` | Serveur Express, gestion de la lecture et intégrations musicales. |
| `spotify/` | Ressources liées à l'intégration Spotify. |
| `package.json` | Dépendances Node.js du projet. |

\<a id="contribuer"\>\</a\>

## 👷 Contribuer

Les améliorations de l'interface, de la documentation et de la fiabilité du lecteur sont les bienvenues.

Pour une modification, décrivez :

- le problème rencontré ;
- le comportement attendu ;
- les vérifications effectuées.

Utilisez des exemples fictifs : les comptes, clés, playlists personnelles et fichiers audio privés doivent rester hors des contributions.

***
\<div align="center"\>

**YouPlayer — un seul lecteur pour votre musique.**

\<sub\>Présentation inspirée du README de \<a href="https://github.com/AntwortEinesLebens/MALINA"\>MALINA\</a\>.\</sub\>
\</div\>
