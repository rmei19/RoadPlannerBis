/**
 * loops.js
 * Génère les listes de coordonnées à soumettre aux moteurs de routage selon
 * le mode de parcours choisi. Ni ORS ni BRouter n'exposent un mode "boucle"
 * fiable pour tous les profils vélo ; on construit donc un polygone
 * approximatif de points de passage autour du départ, que le moteur vient
 * ensuite "coller" au réseau routier réel. C'est l'approche standard des
 * générateurs de boucles (RideWithGPS, Komoot le font de façon similaire
 * en interne).
 *
 * Pour éviter qu'une boucle ne dégénère en simple aller-retour (fréquent
 * quand le réseau routier local ne propose pas d'itinéraire alternatif
 * entre deux sommets du polygone), une validation légère teste la forme
 * réelle obtenue via BRouter (rapide, gratuit) avant de lancer les 3
 * vrais calculs, et re-tire une autre forme si besoin.
 */

const RPLoops = (() => {

  /**
   * Génère N points formant approximativement un polygone dont le
   * périmètre théorique correspond à la distance souhaitée, centré sur
   * un décalage par rapport au départ (pour ne pas repartir plein centre).
   */
  function generateLoopWaypoints(startLatLng, distanceKm, { vertices = 6, seed = null, relief = 'rolling' } = {}) {
    const rng = seed != null ? mulberry32(seed) : Math.random;

    // Rayon approximatif d'un polygone régulier de périmètre = distanceKm
    // (périmètre ≈ 2 * n * R * sin(π/n) pour un polygone à n côtés)
    //
    // CORRECTION DE CIRCUITÉ : une route réelle serpente et contourne les
    // obstacles (rivières, lacs, reliefs...), donc la distance routée est
    // toujours supérieure à la distance à vol d'oiseau entre les sommets du
    // polygone théorique. Sans correction, le parcours final dépasse
    // systématiquement la distance demandée d'environ 25 à 35%. On compense
    // en visant un périmètre théorique plus court que la distance demandée.
    const CIRCUITY_FACTOR = 1.3;
    const n = vertices;
    const perimeterM = (distanceKm * 1000) / CIRCUITY_FACTOR;
    const radiusM = perimeterM / (2 * n * Math.sin(Math.PI / n));

    // Relief souhaité influence légèrement la variation de rayon (plus de
    // variation = plus de dénivelé probable en zone vallonnée/montagneuse)
    const reliefJitter = { flat: 0.05, rolling: 0.15, hilly: 0.25, mountain: 0.35 }[relief] || 0.15;

    const startBearing = rng() * 360;
    const points = [];
    for (let i = 1; i < n; i += 1) {
      const bearing = (startBearing + (i * 360) / n) % 360;
      const jitter = 1 + (rng() * 2 - 1) * reliefJitter;
      const r = radiusM * jitter;
      points.push(RPUtils.destinationPoint(startLatLng, r, bearing));
    }
    return points;
  }

  /** Boucle aléatoire : mêmes principes, mais graine et nombre de sommets tirés aléatoirement à chaque appel. */
  function generateRandomLoopWaypoints(startLatLng, distanceKm, relief) {
    const vertices = 6 + Math.floor(Math.random() * 4); // 6 à 9 sommets
    const seed = Math.floor(Math.random() * 1e9);
    return generateLoopWaypoints(startLatLng, distanceKm, { vertices, seed, relief });
  }

  /** Petit générateur pseudo-aléatoire à graine (déterministe), pour pouvoir reproduire une boucle si besoin. */
  function mulberry32(seed) {
    let a = seed;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Détecte si un tracé repasse significativement sur lui-même : pas
   * seulement un aller-retour symétrique global (cas simple), mais aussi un
   * tracé "en sucette" (une grande boucle avec un long tronçon partagé aller
   * ET retour). Principe : on échantillonne des points le long du parcours
   * (par distance cumulée, pas par index, pour être indépendant de la
   * densité de points du moteur de routage). Pour chaque point échantillon,
   * on cherche le point le plus proche géographiquement PARMI CEUX SUFFISAMMENT
   * ÉLOIGNÉS le long du parcours (pour ignorer les voisins naturels d'un
   * virage). S'il existe un point proche géographiquement mais loin dans le
   * parcours, ce tronçon est emprunté deux fois (aller et retour). Si une
   * proportion trop importante du tracé est dans ce cas, c'est dégénéré.
   */
  function hasSignificantSelfOverlap(latlngs, { thresholdMeters = 40, sampleCount = 60, minPathGapRatio = 0.05, localOverlapMeters = 700 } = {}) {
    const n = latlngs.length;
    if (n < 20) return false;

    // Distance cumulée à chaque point (pour échantillonner par distance, pas par index)
    const cumDist = [0];
    for (let i = 1; i < n; i += 1) {
      cumDist.push(cumDist[i - 1] + RPUtils.haversineDistance(latlngs[i - 1], latlngs[i]));
    }
    const totalDistance = cumDist[n - 1];
    if (totalDistance < 500) return false;

    const minPathGap = totalDistance * minPathGapRatio;

    // Points d'échantillonnage répartis uniformément par distance cumulée
    const sampleIndices = [];
    for (let s = 0; s < sampleCount; s += 1) {
      const targetDist = (s / (sampleCount - 1)) * totalDistance;
      let idx = sampleIndices.length ? sampleIndices[sampleIndices.length - 1] : 0;
      while (idx < n - 1 && cumDist[idx] < targetDist) idx += 1;
      sampleIndices.push(idx);
    }

    const overlapFlags = new Array(sampleIndices.length).fill(false);
    for (let a = 0; a < sampleIndices.length; a += 1) {
      const idxA = sampleIndices[a];
      let closestDist = Infinity;
      for (let b = 0; b < sampleIndices.length; b += 1) {
        if (a === b) continue;
        const idxB = sampleIndices[b];
        if (Math.abs(cumDist[idxA] - cumDist[idxB]) < minPathGap) continue; // voisin naturel, on ignore
        const d = RPUtils.haversineDistance(latlngs[idxA], latlngs[idxB]);
        if (d < closestDist) closestDist = d;
      }
      overlapFlags[a] = closestDist < thresholdMeters;
    }

    // Critère 1 : taux global de chevauchement (aller-retour sur (quasi)
    // toute la boucle).
    const overlapRatio = overlapFlags.filter(Boolean).length / overlapFlags.length;
    if (overlapRatio > 0.28) return true;

    // Critère 2 : une seule portion CONTINUE de chevauchement suffisamment
    // longue (ex. un aller-retour localisé de quelques centaines de mètres à
    // quelques km, comme une antenne en impasse) — même si elle ne représente
    // qu'une petite fraction du tracé total, ce n'est pas une vraie boucle
    // sur ce tronçon.
    let runStart = null;
    for (let i = 0; i <= overlapFlags.length; i += 1) {
      const isOverlap = i < overlapFlags.length && overlapFlags[i];
      if (isOverlap && runStart === null) runStart = i;
      if (!isOverlap && runStart !== null) {
        const distStart = cumDist[sampleIndices[runStart]];
        const distEnd = cumDist[sampleIndices[i - 1]];
        if (distEnd - distStart > localOverlapMeters) return true;
        runStart = null;
      }
    }

    return false;
  }

  /**
   * Génère des points de boucle, valide leur forme réelle via un calcul
   * BRouter rapide AVEC LE PROFIL PROPRE À CET ITINÉRAIRE (pas un profil
   * générique partagé par les 3 : un itinéraire "chemins autorisés" peut
   * emprunter un chemin totalement différent d'un itinéraire "direct", et
   * développer son propre aller-retour jamais détecté par un aperçu
   * générique). Re-tire une nouvelle forme (graine différente) si le
   * résultat s'avère être un aller-retour déguisé. Abandonne après
   * maxAttempts et renvoie la dernière tentative telle quelle (avec un
   * avertissement dans le journal) plutôt que de bloquer la génération.
   */
  async function buildValidatedLoopCoordinates(start, distanceKm, relief, generatorFn, brouterProfile = 'trekking', maxAttempts = 5) {
    let lastCoords = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const loopPts = generatorFn();
      const coords = [start, ...loopPts, start];
      lastCoords = coords;
      try {
        // BRouter (GET, gratuit, rapide) sert uniquement de test de forme,
        // avec le MÊME profil que celui réellement utilisé pour cet
        // itinéraire ; le vrai calcul (ORS ou BRouter selon le moteur choisi)
        // se fait séparément juste après, sur ces mêmes coordonnées.
        const preview = await RPRouting.computeRoute(coords, { name: 'aperçu boucle' }, { profile: brouterProfile, brouterProfile }, { routingEngine: 'brouter' });
        if (!hasSignificantSelfOverlap(preview.latlngs)) {
          if (attempt > 1) RPUtils.debugLog(`Boucle valide obtenue après ${attempt} tentative(s).`, 'ok');
          return coords;
        }
        RPUtils.debugLog(`Tentative ${attempt}/${maxAttempts} : le tracé repasse trop sur lui-même (aller-retour ou tronçon partagé), nouvel essai…`, 'warn');
      } catch (err) {
        // Si même l'aperçu échoue (réseau, etc.), on ne bloque pas la
        // génération pour autant : on renvoie les coordonnées telles quelles.
        RPUtils.debugLog(`Aperçu de boucle impossible à valider (${err.message}), poursuite sans validation.`, 'warn');
        return coords;
      }
    }
    RPUtils.debugLog(`Aucune boucle sans aller-retour trouvée après ${maxAttempts} tentatives, utilisation de la dernière forme générée.`, 'warn');
    return lastCoords;
  }

  /**
   * Génère et valide les coordonnées d'UNE boucle pour UN itinéraire précis
   * (avec son propre profil BRouter de validation). À appeler séparément
   * pour chacun des itinéraires générés, jamais une seule fois partagée.
   */
  async function buildLoopCoordinatesForRoute(mode, start, criteria, brouterProfile) {
    if (mode === 'random-loop') {
      return buildValidatedLoopCoordinates(
        start, criteria.distanceKm, criteria.relief,
        () => generateRandomLoopWaypoints(start, criteria.distanceKm, criteria.relief),
        brouterProfile
      );
    }
    return buildValidatedLoopCoordinates(
      start, criteria.distanceKm, criteria.relief,
      () => generateLoopWaypoints(start, criteria.distanceKm, { relief: criteria.relief }),
      brouterProfile
    );
  }

  /**
   * Génère des points de passage intermédiaires en zigzag le long de l'axe
   * direct start->end, pour allonger artificiellement le trajet jusqu'à
   * approcher targetDistanceKm. Approximatif par nature (comme les boucles) :
   * le moteur de routage colle ensuite ces points au réseau réel, donc la
   * distance finale ne sera jamais exacte, seulement approchée.
   */
  function generateDetourWaypoints(start, end, targetDistanceKm) {
    const directM = RPUtils.haversineDistance(start, end);
    const targetM = targetDistanceKm * 1000;
    const extraM = targetM - directM;
    if (extraM <= 0) return []; // cible déjà atteinte ou inférieure au trajet direct : pas de détour

    const bearing = RPUtils.bearingBetween(start, end);
    const numBumps = Math.max(1, Math.min(4, Math.round(extraM / 12000)));
    // Rayon latéral par détour : chaque aller-retour latéral ajoute environ
    // 2x sa longueur au trajet total (approximation géométrique grossière,
    // le réseau routier réel fera dévier ce chiffre).
    const radiusM = extraM / numBumps / 2.2;

    const points = [];
    for (let i = 1; i <= numBumps; i += 1) {
      const f = i / (numBumps + 1);
      const basePoint = RPUtils.destinationPoint(start, directM * f, bearing);
      const side = i % 2 === 0 ? -1 : 1; // alterne gauche/droite pour un tracé en zigzag
      const detourPoint = RPUtils.destinationPoint(basePoint, radiusM, bearing + 90 * side);
      points.push(detourPoint);
    }
    return points;
  }

  /**
   * Construit la liste finale de coordonnées [lat,lng] à envoyer aux moteurs
   * de routage, pour les modes NON-boucle (les boucles sont désormais
   * générées et validées séparément pour chaque itinéraire, voir
   * buildLoopCoordinatesForRoute, car un aller-retour peut être spécifique à
   * un profil donné et ne pas apparaître avec un autre).
   */
  async function buildCoordinatesForMode(mode, { start, end, waypoints, criteria, detour }) {
    switch (mode) {
      case 'point-to-point': {
        if (!end) throw new Error('Veuillez renseigner un point d\'arrivée.');
        if (detour?.enabled && detour.targetDistanceKm > 0) {
          const detourPts = generateDetourWaypoints(start, end, detour.targetDistanceKm);
          return [start, ...detourPts, ...waypoints, end];
        }
        return [start, ...waypoints, end];
      }

      case 'out-and-back':
        if (!end) throw new Error('Veuillez renseigner un point d\'arrivée (le point à atteindre avant le retour).');
        return [start, ...waypoints, end, start];

      case 'loop-waypoints':
        if (!waypoints.length) throw new Error('Ajoutez au moins un point de passage pour ce mode.');
        return [start, ...waypoints, start];

      case 'loop':
      case 'random-loop':
        throw new Error('Les modes boucle sont générés par itinéraire (buildLoopCoordinatesForRoute), pas ici.');

      default:
        throw new Error(`Mode de parcours inconnu : ${mode}`);
    }
  }

  return { generateLoopWaypoints, generateRandomLoopWaypoints, generateDetourWaypoints, buildCoordinatesForMode, buildLoopCoordinatesForRoute };
})();
