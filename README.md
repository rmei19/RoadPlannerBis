# RoadPlanner Bis (double moteur ORS + BRouter)

Version avec bascule automatique entre OpenRouteService et BRouter. Pour la version ORS pure (+ outil de diagnostic autonome), voir le projet `RoadPlannerORS`.

Application web de préparation de parcours pour le vélo de route — pensée pour être meilleure que Komoot sur les critères spécifiques du cyclisme sur route : boucles, dénivelé, petites routes, pistes cyclables, export multi-format.

100% HTML5 / CSS3 / JavaScript ES6 vanilla. Aucun framework, aucune dépendance de build. Installable comme PWA.

## Fonctionnalités

- Recherche d'adresse, ville, col, lieu-dit ou coordonnées GPS (Nominatim)
- 5 modes de parcours : Aller A→B, Boucle, Boucle aléatoire, Aller-retour, Boucle par points de passage
- **3 parcours générés simultanément** avec des profils différents (Principal / Bis / Cyclable)
- **Deux moteurs de calcul d'itinéraire**, avec bascule automatique :
  - [OpenRouteService](https://openrouteservice.org) (clé API gratuite requise)
  - [BRouter](https://github.com/abrensch/brouter) (service public gratuit, sans clé)
- Statistiques par parcours : distance, dénivelé D+/D-, temps estimé, % pistes cyclables, % petites routes (ORS uniquement), qualité estimée
- Export **GPX**, **TCX** et **FIT** (encodeur binaire natif, compatible Garmin/Wahoo/Coros/Bryton/Hammerhead)
- Interface mobile-first (panneau coulissant tactile) + sidebar fixe sur desktop
- PWA installable, fonctionnement hors-ligne partiel (app shell en cache)

## Démarrage rapide

### Option recommandée : GitHub Pages (aucune installation)

Ce projet est 100% statique — il se prête parfaitement à un hébergement gratuit sur GitHub Pages, ce qui règle définitivement les soucis liés au `file://` (tuiles bloquées, API inaccessibles) rencontrés en local :

1. Pousser ce dépôt sur GitHub (voir section suivante).
2. Dans les paramètres du dépôt : **Settings → Pages → Source → Deploy from a branch → `main` / `(root)`**.
3. L'app sera accessible à `https://<utilisateur>.github.io/<nom-du-repo>/`, en HTTPS, sans rien à configurer.

### Option locale : serveur HTTP

L'app **doit** être servie via http(s), jamais ouverte directement en `file://` (les tuiles de carte et les appels API seraient bloqués par les politiques des serveurs OpenStreetMap/Nominatim).

```bash
git clone <url-du-repo>
cd RoadPlanner
python3 -m http.server 8080
```

Puis ouvrir `http://localhost:8080`.

## Configuration

- **Clé OpenRouteService** (optionnelle si le moteur BRouter ou Automatique est utilisé) : à créer gratuitement sur [openrouteservice.org/dev/#/signup](https://openrouteservice.org/dev/#/signup), puis à coller dans l'onglet **Critères** de l'app. Stockée uniquement dans le `localStorage` du navigateur — jamais dans le code ni committée.
- **Moteur de routage** (onglet Critères) :
  - *Automatique* (par défaut) : tente OpenRouteService, bascule sur BRouter en cas d'échec/indisponibilité.
  - *OpenRouteService uniquement*
  - *BRouter uniquement* : aucune clé nécessaire, mais ne fournit pas le détail % pistes cyclables / % petites routes (affiché "N/D").

## Mettre ce projet sur GitHub

```bash
cd RoadPlanner
git init
git add .
git commit -m "Version initiale de RoadPlanner"
git branch -M main
git remote add origin https://github.com/<utilisateur>/<nom-du-repo>.git
git push -u origin main
```

## Architecture

```
RoadPlanner/
├── index.html
├── manifest.json           # Manifest PWA
├── service-worker.js       # Cache de l'app shell (pas des données dynamiques)
├── css/
│   ├── style.css           # Base commune, thème "instrument de bord cycliste"
│   ├── mobile.css          # Panneau coulissant tactile
│   └── desktop.css         # Sidebar fixe ≥768px
├── js/
│   ├── utils.js            # Formatage, fetch avec timeout, stockage, toasts, logger
│   ├── map.js               # Leaflet, fonds de carte, marqueurs, tracés
│   ├── geocoder.js         # Nominatim (recherche + reverse geocoding)
│   ├── profiles.js         # Définition des 3 profils + lecture des critères UI
│   ├── routing.js          # Moteurs ORS + BRouter, bascule automatique, statistiques
│   ├── loops.js             # Génération des points de passage (boucles)
│   ├── gpx.js               # Export GPX / TCX / FIT
│   ├── weather.js          # Prévisions météo (Open-Meteo, sans clé)
│   ├── ui.js                # Panneau, onglets, rendu des résultats
│   └── app.js                # Orchestration, état applicatif
└── icons/
```

## Limitations connues

- Les statistiques "% pistes cyclables" / "% petites routes" / "grandes routes traversées" ne sont disponibles qu'avec le moteur OpenRouteService (BRouter ne fournit pas cette classification par type de voie).
- L'export FIT utilise un encodeur binaire minimal (messages `file_id`/`course`/`lap`/`record`) : fonctionnel mais non testé sur tous les modèles d'appareils.
- Le nombre de feux tricolores n'est pas calculé (non exposé par les API de routage utilisées).
