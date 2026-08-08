/**
 * poi.js
 * Recherche de points d'intérêt (monuments, musées, points de vue...) via
 * Overpass API (base de données OpenStreetMap, gratuite, sans clé,
 * indépendante des moteurs de routage ORS/BRouter), pour le mode "Visite
 * citadine". Sélectionne un sous-ensemble bien réparti géographiquement
 * (évite que tous les arrêts soient collés dans la même rue), puis les
 * ordonne en une séquence de visite raisonnable (plus proche voisin).
 *
 * Documentation Overpass QL : https://wiki.openstreetmap.org/wiki/Overpass_API
 */

const RPPoi = (() => {

  // Le serveur public principal (overpass-api.de) est fréquemment surchargé
  // (erreurs 504) : c'est un problème connu et documenté côté communauté
  // OpenStreetMap (infrastructure publique gratuite, pas un bug de l'app).
  // On essaie plusieurs miroirs publics dans l'ordre, le premier qui répond
  // est utilisé. IMPORTANT : uniquement des miroirs à couverture MONDIALE
  // confirmée (certains miroirs, comme overpass.osm.ch, ne contiennent que
  // les données d'un seul pays et répondent "avec succès" avec 0 résultat
  // ailleurs — silencieusement trompeur, à éviter absolument).
  const OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://api.openstreetmap.fr/oapi/interpreter',
    'https://overpass.osm.vi-di.fr/api/interpreter',
  ];

  const CATEGORY_LABELS = {
    historic: 'Site historique',
    museum: 'Musée',
    viewpoint: 'Point de vue',
    artwork: "Œuvre d'art",
    gallery: 'Galerie',
    place_of_worship: 'Édifice religieux',
    park: 'Parc',
    attraction: 'Attraction',
  };

  function categorize(tags) {
    if (tags.historic) return 'historic';
    if (tags.tourism === 'museum') return 'museum';
    if (tags.tourism === 'viewpoint') return 'viewpoint';
    if (tags.tourism === 'artwork') return 'artwork';
    if (tags.tourism === 'gallery') return 'gallery';
    if (tags.tourism === 'attraction') return 'attraction';
    if (tags.amenity === 'place_of_worship') return 'place_of_worship';
    if (tags.leisure === 'park') return 'park';
    return 'attraction';
  }

  /**
   * Interroge Overpass pour les points d'intérêt dans un rayon (mètres)
   * autour d'un point [lat,lng]. Ne garde que les éléments nommés (un POI
   * sans nom n'est pas exploitable pour une visite guidée).
   */
  async function fetchPois([lat, lng], radiusMeters) {
    const query = `[out:json][timeout:12];
(
  node["historic"]["name"](around:${radiusMeters},${lat},${lng});
  node["tourism"~"^(attraction|museum|viewpoint|artwork|gallery)$"]["name"](around:${radiusMeters},${lat},${lng});
  node["amenity"="place_of_worship"]["name"](around:${radiusMeters},${lat},${lng});
  node["leisure"="park"]["name"](around:${radiusMeters},${lat},${lng});
);
out body;`;

    let lastError = null;
    for (const url of OVERPASS_URLS) {
      let res;
      try {
        res = await RPUtils.fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: query,
        }, 12000);
      } catch (err) {
        lastError = err.name === 'AbortError'
          ? new Error(`${url} : délai dépassé`)
          : new Error(`${url} : ${err.message}`);
        RPUtils.debugLog(`Overpass (${url}) indisponible, essai du miroir suivant…`, 'warn');
        continue;
      }
      if (!res.ok) {
        lastError = new Error(`${url} a répondu ${res.status}`);
        RPUtils.debugLog(`Overpass (${url}) a répondu ${res.status}, essai du miroir suivant…`, 'warn');
        continue;
      }
      const data = await res.json();
      return (data.elements || [])
        .filter((el) => el.tags && el.tags.name && el.lat != null && el.lon != null)
        .map((el) => {
          const category = categorize(el.tags);
          return {
            lat: el.lat,
            lng: el.lon,
            name: el.tags.name,
            category,
            categoryLabel: CATEGORY_LABELS[category] || 'Point d\'intérêt',
            notable: !!(el.tags.wikipedia || el.tags.wikidata),
          };
        });
    }
    throw new Error('Les serveurs Overpass publics sont surchargés en ce moment (infrastructure gratuite partagée par toute la communauté OpenStreetMap, pas un bug de l\'app) — réessayez dans quelques minutes, ou avec un rayon de recherche plus petit.');
  }

  /**
   * Sélectionne jusqu'à `count` POI en évitant qu'ils soient trop proches
   * les uns des autres (minSeparationM), pour répartir la visite dans
   * l'espace plutôt que d'empiler des arrêts dans la même rue. Priorise les
   * POI "notables" (liés à une fiche Wikipédia/Wikidata) à distance égale.
   */
  function selectDistributedPois(pois, start, count, minSeparationM = 220) {
    const sorted = [...pois].sort((a, b) => {
      if (a.notable !== b.notable) return a.notable ? -1 : 1;
      const da = RPUtils.haversineDistance(start, [a.lat, a.lng]);
      const db = RPUtils.haversineDistance(start, [b.lat, b.lng]);
      return da - db;
    });

    const selected = [];
    for (const poi of sorted) {
      if (selected.length >= count) break;
      const tooClose = selected.some(
        (s) => RPUtils.haversineDistance([s.lat, s.lng], [poi.lat, poi.lng]) < minSeparationM
      );
      if (!tooClose) selected.push(poi);
    }
    return selected;
  }

  /**
   * Ordonne les POI sélectionnés en une séquence de visite raisonnable par
   * heuristique du plus proche voisin (pas un vrai TSP optimal, mais rapide
   * et largement suffisant pour une poignée d'arrêts en ville).
   */
  function orderPoisNearestNeighbor(start, pois) {
    const remaining = [...pois];
    const ordered = [];
    let current = start;
    while (remaining.length) {
      let bestIdx = 0;
      let bestDist = Infinity;
      remaining.forEach((p, i) => {
        const d = RPUtils.haversineDistance(current, [p.lat, p.lng]);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      });
      const [next] = remaining.splice(bestIdx, 1);
      ordered.push(next);
      current = [next.lat, next.lng];
    }
    return ordered;
  }

  return { fetchPois, selectDistributedPois, orderPoisNearestNeighbor, CATEGORY_LABELS };
})();
