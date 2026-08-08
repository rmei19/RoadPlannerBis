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
  // est utilisé. Uniquement des miroirs confirmés compatibles CORS
  // (accessibles depuis un navigateur web, pas juste des outils serveur) et
  // à couverture MONDIALE (certains miroirs, comme overpass.osm.ch, ne
  // contiennent que les données d'un seul pays et répondent "avec succès"
  // avec 0 résultat ailleurs — silencieusement trompeur, à éviter absolument).
  const OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];

  // Secours final si TOUS les miroirs Overpass échouent (infrastructure
  // communautaire parfois surchargée en même temps partout) : l'API de
  // géolocalisation de Wikipédia, une infrastructure bien plus robuste,
  // indépendante d'Overpass. Moins de détail (pas de catégorie précise),
  // mais chaque résultat correspond forcément à un lieu notable (article
  // Wikipédia existant), donc pertinent pour une visite.
  const WIKIPEDIA_GEOSEARCH_URL = 'https://fr.wikipedia.org/w/api.php';

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
   * sans nom n'est pas exploitable pour une visite guidée). Renvoie `null`
   * (pas d'exception) si tous les miroirs échouent, pour laisser fetchPois()
   * basculer sur le secours Wikipédia.
   */
  async function fetchPoisFromOverpass([lat, lng], radiusMeters) {
    const query = `[out:json][timeout:12];
(
  node["historic"]["name"](around:${radiusMeters},${lat},${lng});
  node["tourism"~"^(attraction|museum|viewpoint|artwork|gallery)$"]["name"](around:${radiusMeters},${lat},${lng});
  node["amenity"="place_of_worship"]["name"](around:${radiusMeters},${lat},${lng});
  node["leisure"="park"]["name"](around:${radiusMeters},${lat},${lng});
);
out body;`;

    for (const url of OVERPASS_URLS) {
      let res;
      try {
        res = await RPUtils.fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: query,
        }, 12000);
      } catch (err) {
        RPUtils.debugLog(`Overpass (${url}) indisponible, essai du miroir suivant…`, 'warn');
        continue;
      }
      if (!res.ok) {
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
    return null; // tous les miroirs ont échoué
  }

  /**
   * Secours si Overpass est entièrement indisponible : l'API de
   * géolocalisation de Wikipédia (infrastructure Wikimedia, largement plus
   * robuste que les miroirs communautaires Overpass). Moins de détail (pas
   * de catégorie précise), mais chaque résultat est par nature un lieu
   * notable puisqu'il possède un article Wikipédia.
   */
  async function fetchPoisFromWikipedia([lat, lng], radiusMeters) {
    const params = new URLSearchParams({
      action: 'query',
      list: 'geosearch',
      gscoord: `${lat}|${lng}`,
      gsradius: String(Math.min(10000, Math.round(radiusMeters))), // limite API : 10 km max
      gslimit: '50',
      format: 'json',
      origin: '*', // active le CORS côté API Wikipédia
    });
    const res = await RPUtils.fetchWithTimeout(`${WIKIPEDIA_GEOSEARCH_URL}?${params.toString()}`, {}, 10000);
    if (!res.ok) throw new Error(`Wikipédia a répondu ${res.status}`);
    const data = await res.json();
    const results = data?.query?.geosearch || [];
    return results.map((r) => ({
      lat: r.lat,
      lng: r.lon,
      name: r.title,
      category: 'wikipedia',
      categoryLabel: 'Lieu notable (Wikipédia)',
      notable: true,
    }));
  }

  /**
   * Point d'entrée public : tente Overpass (plusieurs miroirs), et bascule
   * sur Wikipédia GeoSearch si Overpass est entièrement indisponible.
   */
  async function fetchPois(start, radiusMeters) {
    const overpassResults = await fetchPoisFromOverpass(start, radiusMeters);
    if (overpassResults !== null) return overpassResults;

    RPUtils.debugLog('Tous les miroirs Overpass ont échoué, bascule sur Wikipédia (lieux notables uniquement)…', 'warn');
    try {
      const wikiResults = await fetchPoisFromWikipedia(start, radiusMeters);
      RPUtils.debugLog(`Wikipédia a pris le relais avec succès (${wikiResults.length} lieu(x) trouvé(s)).`, 'ok');
      return wikiResults;
    } catch (err) {
      throw new Error('Les serveurs Overpass ET Wikipédia sont indisponibles en ce moment — réessayez dans quelques minutes.');
    }
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
