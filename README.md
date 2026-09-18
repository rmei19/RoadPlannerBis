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

- **Clé OpenRouteService** (optionnelle si le moteur BRouter ou Automatique est utilisé) : à créer gratuitement sur [openrouteservice.org/dev/#/signup](https://openrouteservice.org/dev/#/signup), une clé de démonstration partagée est intégrée à cette version à la demande du propriétaire. Son encodage dans le code ne constitue pas une protection : toute personne visitant le site peut la retrouver. Une clé personnelle peut être saisie dans **Réglages avancés** et sera conservée dans le navigateur.
- **Moteur de routage** (Réglages avancés) :
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
│   ├── ui.js                # Panneau continu, rendu des résultats
│   └── app.js                # Orchestration, état applicatif
└── icons/
```

## Limitations connues

- Les statistiques "% pistes cyclables" / "% petites routes" / "grandes routes traversées" ne sont disponibles qu'avec le moteur OpenRouteService (BRouter ne fournit pas cette classification par type de voie).
- L'export FIT utilise un encodeur binaire minimal (messages `file_id`/`course`/`lap`/`record`) : fonctionnel mais non testé sur tous les modèles d'appareils.
- Le nombre de feux tricolores n'est pas calculé (non exposé par les API de routage utilisées).

## Version 2.2.1 — Tempo Routes

- Clique sur **Tempo** pour ouvrir le menu de la suite ; le bouton thème alterne système, clair et sombre.
- Dans « Points de passage », utilise **+ avant** pour insérer le prochain point (carte ou recherche) à cet emplacement ; les flèches réordonnent les étapes. Les points restent dans cet ordre même avec les détours du mode A→B.
- Pour les boucles, choisis une direction initiale et, si souhaité, coche « Écarter les boucles qui empruntent deux fois le même tronçon ». En l'absence de boucle satisfaisante après cinq essais, aucun tracé répété n'est présenté comme valide. Cela ne coupe pas automatiquement un aller-retour, car un tel découpage déplacerait le départ ou supprimerait l'arrivée.
- Après publication, rafraîchis l'application installée pour activer le cache 2.2.1.

## Version 2.3.0 — Boucles orientées

Le polygone est désormais placé dans la direction choisie (le départ est en bordure de la boucle). Un aperçu BRouter vérifie la direction et les branches redondantes, puis le tracé final ORS/BRouter est revérifié avant affichage. L'option « Écarter les boucles qui empruntent deux fois le même tronçon » est activée par défaut ; un réseau de routes trop contraint peut empêcher de générer un parcours, auquel cas changer la distance, le cap ou désactiver l'option. La clé ORS partagée reste identique.

## Version 2.4.0 — Antennes à couper

Sur les boucles générées, une portion aller-retour reconnue sur la même voie apparaît en violet. Appuyer sur les tirets violets de la carte ou sur le bouton de la fiche de parcours pour retirer cette seule antenne. La détection vérifie le chemin aller et le retour le long du trajet : une boucle qui repasse près de son départ ne suffit pas à déclencher une coupe. Le mode Aller-retour volontaire reste intact. Après la coupe, carte, distance, durée, profil altimétrique et exports GPX/TCX/FIT portent sur le même trajet. Les anciennes statistiques détaillées de voirie ORS sont affichées « N/D » après une coupe car elles ne correspondent plus au parcours raccourci.


## Version 2.5.0 — Panneau unique et boucle centrée

La navigation Rechercher/Critères/Parcours est réunie dans un panneau défilant avec réglages avancés repliables et résultats dans la même vue. La barre Tempo regroupe le menu de la suite, la localisation, le fond de carte et le thème, sur mobile comme sur ordinateur. Dans la direction des boucles, **Centré** répartit les points autour du départ ; les quatre points cardinaux continuent de privilégier un secteur. L’ancienne préférence `random` reste comprise comme `centered`. La clé de démonstration intégrée a été rétablie à la demande du propriétaire (voir Configuration).

## Version 2.6.0 — Parcours plus lisibles

La tolérance et le type de relief ne sont plus demandés dans l'interface : les valeurs internes restent à ±10 % et « vallonné » pour le calcul des boucles. Le réglage de D+ reste accessible. Les boucles sont nettoyées automatiquement des petites antennes (jusqu'à 1,4 km, avec un contrôle strict de la route empruntée) après le calcul et avant l'affichage. Si le retrait est incertain, la portion reste visible en violet et peut être coupée manuellement ; les vrais aller-retours ne sont pas touchés. Des jalons cumulatifs tous les 10 km indiquent le sens de circulation sur la carte, avec une flèche centrale pour les parcours courts. Le profil et les fichiers exportés utilisent le tracé nettoyé.

## Version 2.7.0 — Réglages simplifiés

Le curseur de D+ souhaité a été retiré : il ne modifiait pas le tracé. Le D+ mesuré reste affiché après génération et ne change plus la note de qualité. Les champs « maximum de grandes routes » (simple effet sur la note) et « maximum de feux » (aucun effet) ainsi que les préférences Petites routes, Panoramiques, Villages, Vallées, Cols et Bords de rivière ne sont plus proposés. Les poids de routage restent ceux des trois profils d'itinéraire quand aucune préférence n'était cochée. Course/Gravel/VTT reste disponible et continue de modifier les profils ORS/BRouter. La barre haute utilise les mêmes pictogrammes réglages, localisation et thème que RunPlanner ; l'icône de carte garde l'accès aux fonds de carte. Le bouton réglages ouvre directement la section avancée.


## Version 2.8.5 — Boucles avec points imposés

- Correction de la construction des boucles avec un ou plusieurs points de passage : les points utilisateur sont maintenant insérés dans l'anneau synthétique au segment qui minimise le détour, au lieu d'être placés avant une pointe éloignée qui provoquait souvent un long aller-retour.
- Le redimensionnement après aperçu BRouter agit sur l'anneau synthétique tout en conservant les points utilisateur fixes.
- Chaque nouvelle tentative de boucle produit une géométrie différente.
- Journal moteur clarifié : l'application annonce BRouter directement quand le profil Routes secondaires y est envoyé sans tentative ORS.

## Version 2.8.3 — Limitation des antennes

- Quand « éviter les allers-retours » est activé avec des points imposés, un parcours avec trop de chaussées parcourues deux fois est écarté dans l'aperçu et après le routage final, avant toute coupe automatique. Si aucune boucle correcte n'est trouvée, le motif est indiqué au lieu d'afficher un tracé encombré.
- Le profil « routes secondaires » sur vélo de route utilise directement BRouter en mode automatique : ORS refusait la combinaison `cycling-road` + `avoid_features: highways` à chaque calcul.

## Version 2.8.2 — Respect de la distance avec points de passage

- Une boucle avec points de passage est étendue selon la distance demandée et son aperçu BRouter ajuste progressivement sa taille. La distance du résultat définitif est vérifiée après routage et après suppression des petites antennes.
- Si aucune proposition ne respecte la distance demandée, l'application affiche une erreur au lieu d'accepter silencieusement un trajet beaucoup trop court.

## Version 2.8.1 — Boucles guidées et carte allégée

- Les boucles avec points de passage suivent d'abord les points choisis, dans leur ordre, sans ajouter le polygone de points artificiels. Avec un seul point, un point sur le retour aide à éviter l'aller-retour sur la même route ; si le routage ne permet pas de boucle valable, un autre côté est essayé.
- Une seule étiquette affiche la distance et le temps estimé du parcours complet ; les flèches, jalons de 10 km et temps intermédiaires ont été supprimés.

## Version 2.8.0 — Points de passage dans les boucles

Les modes Boucle et Boucle aléatoire affichent les points de passage. Ceux-ci sont insérés dans le trajet généré dans l'ordre choisi. Le tracé réellement calculé est vérifié avant d'être affiché : si un point ne peut pas être atteint, la génération le signale au lieu de présenter une boucle qui l'ignore. Les petites antennes coupées automatiquement ne peuvent plus supprimer un point demandé.

## Version 2.8.8 — fiabilité boucle et lecture carte

- Correction amortie de la distance des boucles guidées pour éviter les oscillations.
- Conservation du meilleur tracé déjà routé si le moteur échoue lors d’un essai suivant.
- Secours anti-chevauchement légèrement plus permissif avec waypoint.
- Retour des bornes tous les 10 km sur la carte.
- Profil altimétrique interactif : toucher/glisser affiche le point correspondant sur la carte.
- Cartes de résultat remontées sur mobile et navigation interne du panneau corrigée.
- Ajout des fonds OSM France et Satellite.
- Petit vélo dans l’en-tête Tempo Routes.


## Version 2.9.0 — route goudronnée et secours de boucle

- En vélo de route, l’itinéraire 2 utilise `fastbike-verylowtraffic` côté BRouter afin de conserver des petites routes calmes tout en pénalisant fortement les surfaces non goudronnées.
- Si BRouter renvoie une erreur de type `Please, retry later!` après qu’un candidat de boucle acceptable a déjà été trouvé, RoadPlanner conserve désormais ce candidat au lieu de perdre toute la génération.
