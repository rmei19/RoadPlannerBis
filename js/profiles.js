/**
 * profiles.js
 * Définit les 3 itinéraires générés simultanément, et traduit le type de
 * vélo choisi + les critères utilisateur en paramètres concrets pour
 * OpenRouteService et BRouter.
 *
 * OpenRouteService (directions v2) expose notamment :
 *  - profile : cycling-regular | cycling-road | cycling-mountain | cycling-electric
 *  - options.avoid_features : ["highways","steps","fords","ferries"]
 *  - options.profile_params.weightings : { steepness_difficulty, green, quiet }
 *  - preference : "fastest" | "shortest" | "recommended"
 *  - extra_info : ["waytype","surface","steepness","tollways"] (statistiques post-calcul)
 *
 * Différenciation réelle des 3 itinéraires (important : chaque itinéraire a
 * son PROPRE profil BRouter, jamais partagé entre deux itinéraires — sinon,
 * dès qu'ORS bascule sur BRouter pour deux itinéraires à la fois, ils
 * deviennent quasiment identiques puisqu'ils utiliseraient le même moteur
 * avec les mêmes réglages) :
 *  - Itinéraire 1 : "comme une voiture" — préférence "fastest", n'évite PAS
 *    les grands axes (avoid_features ne contient pas "highways"). Comme les
 *    profils vélo d'ORS/BRouter excluent de toute façon les voies interdites
 *    aux vélos (autoroutes réelles), c'est bien "le plus direct des
 *    itinéraires légalement empruntables à vélo", pas une vraie autoroute.
 *  - Itinéraire 2 : évite explicitement les grands axes (avoid_features
 *    inclut "highways"), forçant un tracé structurellement différent du 1,
 *    pas juste une préférence différente sur le même réseau.
 *  - Itinéraire 3 : profil ORS différent (cycling-regular, plus tolérant
 *    aux chemins) + évite grands axes et escaliers, poids "green" maximal.
 *
 * Limite connue : l'API ORS ne propose pas de paramètre direct "éviter le
 * non-goudronné" pour les profils vélo (contrairement au profil "wheelchair").
 * Le "100% béton" des itinéraires 1 et 2 s'obtient donc en s'appuyant sur le
 * profil "cycling-road" (conçu par ORS pour privilégier les routes goudronnées)
 * plutôt que sur un filtre explicite. Le % de surface non-pavée réellement
 * emprunté reste visible dans les statistiques du parcours (extra_info surface).
 */

const RPProfiles = (() => {

  /**
   * Mapping type de vélo -> profils moteur, PAR itinéraire (jamais partagé
   * entre deux itinéraires, y compris côté BRouter).
   */
  const BIKE_TYPE_ENGINE_PROFILES = {
    road: {
      principal: { ors: 'cycling-road', brouter: 'fastbike' },
      bis: { ors: 'cycling-road', brouter: 'trekking' },
      cyclable: { ors: 'cycling-regular', brouter: 'safety' },
    },
    vtt: {
      // Un VTT est par nature à l'aise sur chemin : profil ORS "tout-terrain"
      // pour les 3, mais un profil BRouter distinct pour chacun (variation
      // de tranquillité/directité même en tout-terrain).
      principal: { ors: 'cycling-mountain', brouter: 'MTB' },
      bis: { ors: 'cycling-mountain', brouter: 'trekking' },
      cyclable: { ors: 'cycling-mountain', brouter: 'safety' },
    },
    gravel: {
      // Pas de profil "gravel" dédié côté ORS/BRouter : cycling-regular /
      // trekking est le plus proche (tolère un mélange goudron + chemins).
      principal: { ors: 'cycling-regular', brouter: 'fastbike' },
      bis: { ors: 'cycling-regular', brouter: 'trekking' },
      cyclable: { ors: 'cycling-regular', brouter: 'safety' },
    },
  };

  const ROUTE_DEFS = [
    {
      id: 'principal',
      name: 'Itinéraire 1 — Direct (façon voiture, sans voie interdite aux vélos)',
      color: 'var(--color-route-principal)',
      colorHex: '#FF5A36',
      description: 'Le plus direct/rapide : n\'évite pas les grands axes, préférence "le plus rapide".',
      buildOptions: (criteria) => {
        const engines = enginesFor(criteria, 'principal');
        return {
          profile: engines.ors,
          brouterProfile: engines.brouter,
          avoid_features: ['ferries', 'fords'], // volontairement PAS "highways" : c'est ce qui rend cet itinéraire vraiment direct
          weightings: { quiet: 0, green: 0 },
          preference: 'fastest',
        };
      },
    },
    {
      id: 'bis',
      name: 'Itinéraire 2 — Routes secondaires',
      color: 'var(--color-route-bis)',
      colorHex: '#1E88E5',
      description: 'Évite explicitement les grands axes, privilégie les petites routes peu fréquentées.',
      buildOptions: (criteria) => {
        const engines = enginesFor(criteria, 'bis');
        return {
          profile: engines.ors,
          brouterProfile: engines.brouter,
          avoid_features: ['highways', 'ferries', 'fords'],
          weightings: { quiet: 1, green: 0.4 },
          preference: 'recommended',
        };
      },
    },
    {
      id: 'cyclable',
      name: 'Itinéraire 3 — Chemins autorisés',
      color: 'var(--color-route-cyclable)',
      colorHex: '#00C853',
      description: 'Profil différent (plus tolérant), accepte quelques chemins de terre / pistes non goudronnées.',
      buildOptions: (criteria) => {
        const engines = enginesFor(criteria, 'cyclable');
        return {
          profile: engines.ors,
          brouterProfile: engines.brouter,
          avoid_features: ['highways', 'steps', 'ferries', 'fords'],
          weightings: { green: 1, quiet: 0.5 },
          preference: 'recommended',
        };
      },
    },
  ];

  function enginesFor(criteria, routeId) {
    const bikeType = criteria?.bikeType || 'road';
    const table = BIKE_TYPE_ENGINE_PROFILES[bikeType] || BIKE_TYPE_ENGINE_PROFILES.road;
    return table[routeId];
  }

  /** Lit les critères actuellement définis dans l'onglet "Critères" du panneau. */
  function readCriteriaFromUI() {
    const getVal = (id) => document.getElementById(id)?.value;
    const activePrefs = Array.from(document.querySelectorAll('.chip.is-active'))
      .map((el) => el.dataset.pref);

    return {
      distanceKm: parseFloat(getVal('range-distance')) || 60,
      toleranceRatio: (parseFloat(getVal('range-tolerance')) || 10) / 100,
      elevationTarget: parseFloat(getVal('range-elevation')) || 1000,
      relief: getVal('select-relief') || 'rolling',
      maxMajorRoads: parseInt(getVal('range-major-roads'), 10) || 0,
      maxLights: parseInt(getVal('range-lights'), 10) || 0,
      avgSpeedKmh: parseFloat(getVal('range-speed')) || 27,
      preferences: activePrefs,
      routingEngine: getVal('select-engine') || 'auto',
      bikeType: getVal('select-bike-type') || 'road',
      routeCount: parseInt(getVal('select-route-count'), 10) || 1,
    };
  }

  /** Ajuste dynamiquement les poids ORS en fonction des préférences cochées par l'utilisateur. */
  function applyUserPreferences(baseOptions, criteria) {
    const options = JSON.parse(JSON.stringify(baseOptions));
    const w = options.weightings;
    if (criteria.preferences.includes('small-roads')) w.quiet = Math.min(1, w.quiet + 0.2);
    if (criteria.preferences.includes('scenic')) w.green = Math.min(1, w.green + 0.2);
    if (criteria.preferences.includes('cols')) options.profile_hint_climb = true;
    if (criteria.preferences.includes('riverside') || criteria.preferences.includes('valleys')) {
      w.green = Math.min(1, w.green + 0.1);
    }
    // Relief souhaité : influence le profil de recherche de boucle (voir loops.js)
    options.reliefTarget = criteria.relief;
    return options;
  }

  /** Retourne les N premières définitions de parcours selon le nombre choisi par l'utilisateur (1, 2 ou 3). */
  function getRouteDefinitions(count = 3) {
    return ROUTE_DEFS.slice(0, Math.max(1, Math.min(3, count)));
  }

  return { getRouteDefinitions, readCriteriaFromUI, applyUserPreferences };
})();
