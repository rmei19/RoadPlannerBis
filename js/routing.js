/**
 * routing.js
 * Interface avec les moteurs de calcul d'itinéraire : OpenRouteService
 * (Directions v2 / GeoJSON) et BRouter (service public gratuit, sans clé),
 * avec bascule automatique de l'un vers l'autre en cas d'indisponibilité.
 * Extrait ensuite des statistiques exploitables (dénivelé, part de pistes
 * cyclables, part de petites routes quand disponible, estimation de qualité).
 *
 * Documentation ORS : https://openrouteservice.org/dev/#/api-docs/v2/directions
 * Documentation BRouter : https://github.com/abrensch/brouter
 *
 * Classification "waytype" ORS (extra_info) :
 *   0 Inconnu, 1 Route d'État/nationale, 2 Route, 3 Rue, 4 Chemin,
 *   5 Piste, 6 Voie cyclable, 7 Trottoir, 8 Escaliers, 9 Ferry, 10 Construction
 *
 * BRouter ne fournit pas cette classification par type de voie : les champs
 * cyclewayShare / smallRoadsShare / majorRoadsShare / majorRoadCrossings
 * valent alors `null` (affichés "N/D" côté UI) plutôt que d'être estimés au hasard.
 */

const RPRouting = (() => {

  const ORS_BASE = 'https://api.openrouteservice.org/v2/directions';
  const BROUTER_BASE = 'https://brouter.de/brouter';
  const WAYTYPE_CYCLEWAY = 6;
  const WAYTYPE_MAJOR = 1;      // routes d'État / nationales -> "grandes routes"
  const WAYTYPE_SMALL = [2, 3, 5]; // route/rue/piste -> "petites routes"
  // Classification "surface" ORS (extra_info) : 0 Inconnu, 1 Pavé, 2 Non pavé,
  // 3 Asphalte, 4 Béton, 5 Pavés, 6 Métal, 7 Bois, 8 Gravier compacté,
  // 9 Gravier fin, 10 Gravier, 11 Terre, 12 Sol, 13 Glace, 14 Pavés (dalles),
  // 15 Sable, 16 Copeaux de bois, 17 Herbe, 18 Herbe sur dalles
  const SURFACE_UNPAVED = [2, 8, 9, 10, 11, 12, 15, 16, 17, 18];

  // Clé API par défaut, à la demande explicite de l'utilisateur, stockée
  // BROUILLÉE (inversée + ré-encodée en base64) plutôt qu'en clair.
  //
  // IMPORTANT : ceci n'est PAS un vrai chiffrement. Dans une app 100% côté
  // client (aucun serveur derrière), il n'existe aucun moyen de dissimuler
  // un secret à quelqu'un qui lit le code : la fonction de débrouillage est
  // juste en dessous, à la portée de n'importe qui. Ce brouillage vise
  // uniquement à échapper aux ROBOTS qui scannent GitHub à la recherche de
  // motifs de clés API reconnaissables (ex. structure JWT en base64) —
  // la menace la plus probable pour un dépôt public comme celui-ci. Contre
  // une personne qui inspecte volontairement ce fichier, ça n'offre aucune
  // protection réelle.
  //
  // Risque résiduel : épuisement du quota gratuit par un tiers, ou révocation
  // de la clé par OpenRouteService en cas d'abus détecté. Pour régénérer une
  // nouvelle clé si besoin : openrouteservice.org (Dashboard -> Request a
  // token), puis remplacer OBFUSCATED_API_KEY ci-dessous par sa nouvelle
  // version brouillée (inverser la clé, puis l'encoder en base64).
  const OBFUSCATED_API_KEY = 'PTBuSTBZamMxMW1jMTFtSTZJQ2Fpd2lJeE1XWXhFV04wa2pOaVIyTjJrak00QURaaVJEWjFFV1l6UW1OMGt6WXlNbUk2SUNacEpDTGlnRE55WWpaakZETXdBVE14RVRONGNUTzFNVFpqTmpZMUlpT2ljbWN2Snll';

  function deobfuscateKey(obfuscated) {
    try {
      const reversed = atob(obfuscated);
      return reversed.split('').reverse().join('');
    } catch {
      return '';
    }
  }

  /** Une clé API valide pour un en-tête HTTP ne doit contenir que des
   * caractères ASCII imprimables. Une valeur invalide (autofill du
   * navigateur, copier-coller parasite...) ferait planter fetch() avec
   * "String contains non ISO-8859-1 code point" — on l'ignore plutôt que de
   * laisser planter la requête. */
  function isPlausibleApiKey(key) {
    return typeof key === 'string' && key.length > 10 && /^[\x20-\x7E]+$/.test(key);
  }

  function getApiKey() {
    const candidates = [
      document.getElementById('input-ors-key')?.value?.trim(),
      RPUtils.storage.get('rp_ors_key', ''),
      deobfuscateKey(OBFUSCATED_API_KEY),
    ];
    return candidates.find(isPlausibleApiKey) || '';
  }

  /**
   * Point d'entrée unique utilisé par app.js. Choisit le moteur selon
   * criteria.routingEngine ('auto' | 'ors' | 'brouter') :
   *  - 'ors'     : uniquement OpenRouteService, échoue si indisponible.
   *  - 'brouter' : uniquement BRouter.
   *  - 'auto'    : tente ORS, puis bascule automatiquement sur BRouter en
   *                cas d'échec (timeout, erreur réseau, clé manquante...).
   * def est la définition de parcours (RPProfiles) : fournit son nom pour les
   * logs. orsOptions.brouterProfile (calculé par profiles.js selon le type de
   * vélo choisi) fournit le profil BRouter à utiliser.
   */
  async function computeRoute(latlngPoints, def, orsOptions, criteria) {
    const engine = criteria?.routingEngine || 'auto';

    if (engine === 'ors') {
      return computeRouteORS(latlngPoints, orsOptions);
    }
    if (engine === 'brouter') {
      return computeRouteBRouter(latlngPoints, orsOptions.brouterProfile);
    }

    // Mode automatique : ORS d'abord, repli sur BRouter si ça échoue.
    try {
      return await computeRouteORS(latlngPoints, orsOptions);
    } catch (orsErr) {
      RPUtils.debugLog(`ORS indisponible pour "${def.name}" (${orsErr.message}), bascule sur BRouter…`, 'warn');
      try {
        const stats = await computeRouteBRouter(latlngPoints, orsOptions.brouterProfile);
        RPUtils.debugLog(`BRouter a pris le relais avec succès pour "${def.name}".`, 'ok');
        return stats;
      } catch (brouterErr) {
        // Les deux moteurs ont échoué : on remonte une erreur combinée et lisible.
        throw new Error(`ORS: ${orsErr.message} — BRouter: ${brouterErr.message}`);
      }
    }
  }

  /* ======================================================================
     OpenRouteService
     ====================================================================== */

  async function computeRouteORS(latlngPoints, orsOptions, extra = {}) {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error('Aucune clé API OpenRouteService renseignée (onglet Critères).');
    }
    if (latlngPoints.length < 2) {
      throw new Error('Il faut au moins un départ et une arrivée.');
    }

    const coordinates = latlngPoints.map(([lat, lng]) => [lng, lat]); // ORS attend [lng,lat]

    const body = {
      coordinates,
      elevation: true,
      extra_info: ['waytype', 'surface', 'steepness'],
      instructions: false,
      preference: orsOptions.preference || 'recommended',
      options: {
        avoid_features: orsOptions.avoid_features || [],
        profile_params: {
          weightings: orsOptions.weightings || {},
        },
      },
      ...extra, // permet d'injecter options round_trip pour les boucles (voir loops.js)
    };

    const url = `${ORS_BASE}/${orsOptions.profile}/geojson`;

    let res;
    try {
      res = await RPUtils.fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Authorization': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json, application/geo+json',
        },
        body: JSON.stringify(body),
      }, 20000); // 20 s max : évite un blocage indéfini
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('délai dépassé (20 s), le serveur ORS ne répond pas');
      }
      throw new Error(`connexion impossible (${err.message})`);
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = errBody?.error?.message || `le serveur a répondu ${res.status}`;
      throw new Error(msg);
    }

    const geojson = await res.json();
    return normalizeOrsResponse(geojson, 'ors');
  }

  /** Convertit la réponse GeoJSON ORS en objet interne exploitable par l'UI. */
  function normalizeOrsResponse(geojson, engine) {
    const feature = geojson.features?.[0];
    if (!feature) throw new Error('réponse vide');

    const coords = feature.geometry.coordinates; // [lng,lat,ele?]
    const latlngs = coords.map((c) => [c[1], c[0]]);

    const summary = feature.properties.summary || {};
    const ascent = feature.properties.ascent ?? computeAscentFromCoords(coords).ascent;
    const descent = feature.properties.descent ?? computeAscentFromCoords(coords).descent;

    const extras = feature.properties.extras || {};
    const totalDistance = summary.distance || 0;

    const cyclewayShare = shareForWaytype(extras.waytype, totalDistance, [WAYTYPE_CYCLEWAY]);
    const smallRoadsShare = shareForWaytype(extras.waytype, totalDistance, WAYTYPE_SMALL);
    const majorRoadsShare = shareForWaytype(extras.waytype, totalDistance, [WAYTYPE_MAJOR]);
    const majorRoadCrossings = countSegmentTransitions(extras.waytype, [WAYTYPE_MAJOR]);
    const unpavedShare = shareForWaytype(extras.surface, totalDistance, SURFACE_UNPAVED);

    return {
      engine,
      latlngs,
      distance: totalDistance,
      duration: summary.duration || 0,
      ascent,
      descent,
      cyclewayShare,
      smallRoadsShare,
      majorRoadsShare,
      majorRoadCrossings,
      unpavedShare,
      raw: feature,
    };
  }

  /* ======================================================================
     BRouter (service public gratuit, sans clé)
     ====================================================================== */

  /**
   * Appelle le serveur public BRouter (simple GET, pas de corps JSON — donc
   * pas de préflight CORS et pas de sensibilité à la taille de la requête).
   * brouterProfile : nom de profil standard BRouter (ex. "fastbike", "trekking", "safety").
   */
  async function computeRouteBRouter(latlngPoints, brouterProfile) {
    if (latlngPoints.length < 2) {
      throw new Error('Il faut au moins un départ et une arrivée.');
    }
    const lonlats = latlngPoints.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join('|');
    const params = new URLSearchParams({
      lonlats,
      profile: brouterProfile || 'trekking',
      alternativeidx: '0',
      format: 'geojson',
    });
    const url = `${BROUTER_BASE}?${params.toString()}`;

    let res;
    try {
      res = await RPUtils.fetchWithTimeout(url, { method: 'GET' }, 20000);
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('délai dépassé (20 s), le serveur BRouter ne répond pas');
      }
      throw new Error(`connexion impossible (${err.message})`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text.slice(0, 120) || `le serveur a répondu ${res.status}`);
    }

    const geojson = await res.json();
    return normalizeBrouterResponse(geojson);
  }

  /** Convertit la réponse GeoJSON BRouter en objet interne (même forme que la réponse ORS). */
  function normalizeBrouterResponse(geojson) {
    const feature = geojson.features?.[0];
    if (!feature) throw new Error('réponse vide');

    const coords = feature.geometry.coordinates; // [lng,lat,ele?]
    const latlngs = coords.map((c) => [c[1], c[0]]);
    const { ascent, descent } = computeAscentFromCoords(coords);

    // BRouter fournit la distance/durée dans ses propriétés (noms variables
    // selon la version du serveur) ; on retombe sur un calcul géométrique sinon.
    const props = feature.properties || {};
    const distance = Number(props['track-length']) || totalDistanceFromCoords(latlngs);
    const duration = Number(props['total-time']) || null;

    return {
      engine: 'brouter',
      latlngs,
      distance,
      duration: duration || estimateDurationFallback(distance),
      ascent,
      descent,
      // BRouter ne classe pas les tronçons par type de voie : ces stats sont
      // inconnues plutôt qu'estimées au hasard (voir rendu "N/D" dans ui.js).
      cyclewayShare: null,
      smallRoadsShare: null,
      majorRoadsShare: null,
      majorRoadCrossings: null,
      unpavedShare: null,
      raw: feature,
    };
  }

  function totalDistanceFromCoords(latlngs) {
    let total = 0;
    for (let i = 1; i < latlngs.length; i += 1) {
      total += RPUtils.haversineDistance(latlngs[i - 1], latlngs[i]);
    }
    return total;
  }

  /** Repli grossier si BRouter ne renvoie pas de durée exploitable (rare) : 18 km/h par défaut. */
  function estimateDurationFallback(distanceMeters) {
    return (distanceMeters / 1000 / 18) * 3600;
  }

  /* ======================================================================
     Utilitaires communs
     ====================================================================== */

  /** Calcule la part (0..1) de distance parcourue sur des tronçons appartenant à certaines catégories waytype (ORS uniquement). */
  function shareForWaytype(waytypeExtra, totalDistance, values) {
    if (!waytypeExtra?.summary?.length || !totalDistance) return 0;
    const matched = waytypeExtra.summary
      .filter((s) => values.includes(s.value))
      .reduce((sum, s) => sum + (s.distance || 0), 0);
    return Math.min(1, matched / totalDistance);
  }

  /** Compte le nombre de transitions vers une catégorie de route (ORS uniquement). */
  function countSegmentTransitions(waytypeExtra, values) {
    if (!waytypeExtra?.values?.length) return 0;
    let count = 0;
    let wasIn = false;
    waytypeExtra.values.forEach(([, , value]) => {
      const isIn = values.includes(value);
      if (isIn && !wasIn) count += 1;
      wasIn = isIn;
    });
    return count;
  }

  /** Repli si l'ascent/descent n'est pas fourni par l'API : calcul brut depuis les altitudes. */
  function computeAscentFromCoords(coords) {
    let ascent = 0;
    let descent = 0;
    for (let i = 1; i < coords.length; i += 1) {
      const d = (coords[i][2] || 0) - (coords[i - 1][2] || 0);
      if (d > 0) ascent += d;
      else descent += -d;
    }
    return { ascent, descent };
  }

  /**
   * Calcule une note de qualité (0 à 5) basée sur l'adéquation aux critères
   * utilisateur. Quand les statistiques de type de voie sont inconnues
   * (BRouter), le critère "tranquillité" est neutre plutôt qu'à zéro pour
   * ne pas pénaliser injustement ce moteur dans la note globale.
   */
  function estimateQuality(routeStats, criteria, profileId) {
    let score = 0;

    const quietShare = profileId === 'cyclable' ? routeStats.cyclewayShare : routeStats.smallRoadsShare;
    score += quietShare == null ? 1 : Math.min(2, quietShare * 2);

    if (routeStats.majorRoadCrossings == null) {
      score += 0.5; // inconnu (BRouter) : score neutre
    } else if (criteria.maxMajorRoads != null) {
      score += routeStats.majorRoadCrossings <= criteria.maxMajorRoads ? 1 : 0.3;
    }

    const targetDistanceM = criteria.distanceKm * 1000;
    if (targetDistanceM > 0) {
      const distanceError = Math.abs(routeStats.distance - targetDistanceM) / targetDistanceM;
      score += Math.max(0, 1 - distanceError * 2);
    }

    if (criteria.elevationTarget > 0) {
      const eleError = Math.abs(routeStats.ascent - criteria.elevationTarget) / criteria.elevationTarget;
      score += Math.max(0, 1 - eleError);
    } else {
      score += routeStats.ascent < 300 ? 1 : 0.5;
    }

    return Math.max(0, Math.min(5, Math.round(score * 10) / 10));
  }

  return { computeRoute, getApiKey, estimateQuality };
})();
