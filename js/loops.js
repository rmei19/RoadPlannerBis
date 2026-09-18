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
  function generateLoopWaypoints(startLatLng, distanceKm, { vertices = 6, seed = null, relief = 'rolling', direction = 'centered' } = {}) {
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
    // CORRECTION DE CIRCUITÉ : une route réelle serpente et contourne les
    // obstacles (rivières, lacs, reliefs...), donc la distance routée est
    // toujours supérieure à la distance à vol d'oiseau entre les sommets du
    // polygone théorique. Un premier facteur de 1.3 s'est avéré insuffisant
    // en usage réel (retours observés : 60km voulus -> 80km réels, 40km
    // voulus -> 60km réels, soit un ratio réel/voulu de 1.33 à 1.5 malgré la
    // correction) : le facteur nécessaire est donc plus proche de 1.8.
    const CIRCUITY_FACTOR = 1.8;
    const n = vertices;
    const perimeterM = (distanceKm * 1000) / CIRCUITY_FACTOR;
    const radiusM = perimeterM / (2 * n * Math.sin(Math.PI / n));

    // Relief souhaité influence légèrement la variation de rayon (plus de
    // variation = plus de dénivelé probable en zone vallonnée/montagneuse)
    const reliefJitter = { flat: 0.05, rolling: 0.15, hilly: 0.25, mountain: 0.35 }[relief] || 0.15;

    const headings = { north: 0, east: 90, south: 180, west: 270 };
    const oriented = Object.hasOwn(headings, direction);
    const heading = oriented ? headings[direction] : rng() * 360;
    // Le départ est sur le bord OUEST d'une boucle orientée EST (idem pour
    // les autres caps), et non plus au centre du polygone. C'est la différence
    // entre « premier point vers l'est » et « boucle située à l'est ».
    // En mode centré, le départ reste à l'intérieur de la boucle. Un léger
    // décalage évite un polygone parfaitement symétrique, difficile à router
    // sur les petites routes. L'ancienne valeur enregistrée "random" suit
    // aussi ce comportement pour conserver les réglages existants.
    const center = RPUtils.destinationPoint(startLatLng, radiusM * (oriented ? 1 : 0.28), heading);
    const points = [];
    for (let i = 1; i < n; i += 1) {
      const bearing = (heading + 180 + i * 360 / n) % 360;
      const jitter = 1 + (rng() * 2 - 1) * reliefJitter;
      points.push(RPUtils.destinationPoint(center, radiusM * jitter, bearing));
    }
    return points;
  }

  /** Boucle aléatoire : mêmes principes, mais graine et nombre de sommets tirés aléatoirement à chaque appel. */
  function generateRandomLoopWaypoints(startLatLng, distanceKm, relief, direction = 'centered') {
    const vertices = 6 + Math.floor(Math.random() * 4); // 6 à 9 sommets
    const seed = Math.floor(Math.random() * 1e9);
    return generateLoopWaypoints(startLatLng, distanceKm, { vertices, seed, relief, direction });
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

  /** Évalue le tracé routé, pas seulement les points théoriques.
   * Tolère un court détour au départ ; écarte une grande branche à l'opposé
   * de la direction demandée. Une route sans géométrie suffisante n'est pas
   * validée silencieusement.
   */
  function validateLoopRoute(latlngs, start, direction, avoidOverlap = false) {
    if (!Array.isArray(latlngs) || latlngs.length < 2) return { ok: false, reason: 'Tracé incomplet.' };
    const bearing = { north: 0, east: 90, south: 180, west: 270 }[direction];
    if (bearing !== undefined) {
      const phi = bearing * Math.PI / 180;
      const latScale = 111195, lngScale = latScale * Math.cos(start[0] * Math.PI / 180);
      let forward = 0, backward = 0;
      for (const point of latlngs) {
        const projection = ((point[1] - start[1]) * lngScale) * Math.sin(phi)
          + ((point[0] - start[0]) * latScale) * Math.cos(phi);
        forward = Math.max(forward, projection);
        backward = Math.max(backward, -projection);
      }
      if (forward < 1500 || backward > Math.max(1800, forward * 0.35)) {
        return { ok: false, reason: `Le tracé s'éloigne trop dans la direction opposée (${Math.round(backward / 1000)} km).` };
      }
    }
    if (avoidOverlap && hasSignificantSelfOverlap(latlngs) && !RPOverlaps.findSegments(latlngs).length) {
      return { ok: false, reason: 'Le trajet repasse sur un long tronçon non découpable.' };
    }
    return { ok: true };
  }

  /** Insère les passages imposés dans l'anneau théorique sans changer leur ordre.
   * Le coût d'insertion minimise le détour à vol d'oiseau. Le moteur de
   * routage calcule ensuite les véritables routes entre ces points.
   */
  function insertUserWaypoints(start, syntheticPoints, userWaypoints) {
    const ring = [start, ...syntheticPoints, start];
    if (!userWaypoints.length) return ring;
    const segmentCount = ring.length - 1;
    const cost = (point, segment) =>
      RPUtils.haversineDistance(ring[segment], point)
      + RPUtils.haversineDistance(point, ring[segment + 1])
      - RPUtils.haversineDistance(ring[segment], ring[segment + 1]);
    const dp = userWaypoints.map(() => Array(segmentCount).fill(Infinity));
    const parent = userWaypoints.map(() => Array(segmentCount).fill(-1));
    for (let segment = 0; segment < segmentCount; segment++) dp[0][segment] = cost(userWaypoints[0], segment);
    for (let point = 1; point < userWaypoints.length; point++) {
      for (let segment = 0; segment < segmentCount; segment++) {
        for (let previous = 0; previous <= segment; previous++) {
          const candidate = dp[point - 1][previous] + cost(userWaypoints[point], segment);
          if (candidate < dp[point][segment]) {
            dp[point][segment] = candidate;
            parent[point][segment] = previous;
          }
        }
      }
    }
    let segment = dp.at(-1).indexOf(Math.min(...dp.at(-1)));
    const bins = Array.from({ length: segmentCount }, () => []);
    for (let point = userWaypoints.length - 1; point >= 0; point--) {
      bins[segment].unshift(userWaypoints[point]);
      segment = parent[point][segment];
    }
    return ring.flatMap((anchor, i) => i < bins.length ? [anchor, ...bins[i]] : [anchor]);
  }

  /** Construit un grand tour autour des points imposés. L'extension dans la
   * direction demandée et le retour latéral sont dimensionnés par la distance
   * souhaitée, et non par la distance départ → dernier point (parfois 3 km).
   * scale est corrigé ensuite avec la longueur réellement routée par BRouter.
   */
  function buildUserGuidedLoop(start, waypoints, distanceKm, attempt = 1, direction = 'centered', scale = 1) {
    const headings = { north: 0, east: 90, south: 180, west: 270 };
    const oriented = Object.hasOwn(headings, direction);
    const heading = oriented ? headings[direction] : RPUtils.bearingBetween(start, waypoints[0]);
    const radians = heading * Math.PI / 180;
    const lngScale = 111195 * Math.cos(start[0] * Math.PI / 180);
    const projection = (p) => (p[1] - start[1]) * lngScale * Math.sin(radians)
      + (p[0] - start[0]) * 111195 * Math.cos(radians);
    const furthest = Math.max(0, ...waypoints.map(projection));
    const reach = Math.max(distanceKm * 300 * scale, furthest + distanceKm * 80 * scale);
    const tip = RPUtils.destinationPoint(start, reach, heading);
    const side = attempt > 3 ? -1 : 1;
    const returnFraction = [0.55, 0.72, 0.38][(attempt - 1) % 3];
    const returnMidpoint = RPUtils.destinationPoint(start, reach * returnFraction, heading);
    const flank = RPUtils.destinationPoint(returnMidpoint, distanceKm * 140 * scale, heading + side * 90);
    const last = waypoints.at(-1);
    // Évite deux points quasi superposés qui provoqueraient une antenne.
    const addTip = RPUtils.haversineDistance(last, tip) > 1200;
    return [start, ...waypoints, ...(addTip ? [tip] : []), flank, start];
  }

  /** Vérifie les passages réels dans l'ordre sélectionné, après routage. */
  function validateUserWaypoints(latlngs, waypoints, toleranceM = 200) {
    let previousIndex = 0;
    for (let i = 0; i < waypoints.length; i++) {
      let nearestIndex = -1, nearestDistance = Infinity;
      for (let j = previousIndex; j < latlngs.length; j++) {
        const distance = RPUtils.haversineDistance(latlngs[j], waypoints[i]);
        if (distance < nearestDistance) { nearestDistance = distance; nearestIndex = j; }
      }
      if (nearestDistance > toleranceM) {
        return { ok: false, reason: `Le parcours ne passe pas par le point de passage ${i + 1} (${Math.round(nearestDistance)} m d'écart).` };
      }
      previousIndex = nearestIndex;
    }
    return { ok: true };
  }

  /** Une boucle qui repasse plusieurs kilomètres sur elle-même ne doit pas
   * être acceptée parce que ces portions seraient ensuite découpables. */
  function validateSpurBudget(latlngs, targetKm, { relaxed = false } = {}) {
    const spurs = RPOverlaps.findSegments(latlngs);
    const extraM = spurs.reduce((total, segment) => total + segment.removedDistanceM, 0);
    // Validation normale : environ 3,5 % de la distance demandée, avec un
    // minimum de 1 km. En secours, on tolère davantage sur une boucle guidée
    // par waypoint : jusqu'à ~16 % (plafonné à 7,5 km). L'objectif est de
    // garder un parcours praticable plutôt que de renvoyer systématiquement
    // zéro résultat quand le réseau routier impose un court tronc commun.
    const strictBudgetM = Math.max(1000, targetKm * 35);
    const relaxedBudgetM = Math.max(3200, Math.min(7500, targetKm * 160));
    const budgetM = relaxed ? relaxedBudgetM : strictBudgetM;
    return extraM <= budgetM
      ? { ok: true, extraM, budgetM, relaxed }
      : { ok: false, extraM, budgetM, relaxed, reason: `${(extraM / 1000).toFixed(1)} km d'aller-retour sur la même route.` };
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
  async function buildValidatedLoopCoordinates(start, distanceKm, relief, generatorFn, brouterProfile = 'trekking', maxAttempts = 5, requireUniqueRoads = false, direction = 'random', userWaypoints = [], toleranceRatio = 0.1) {
    let lastCoords = null;
    let trimmableCoords = null;
    let lastReason = '';
    let scale = 1;
    let bestFallback = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Toujours construire d'abord une vraie forme de boucle synthétique.
      // Si des points utilisateur sont imposés, on les insère ensuite dans le
      // segment de l'anneau qui minimise le détour. L'ancienne stratégie
      // [départ -> waypoint -> pointe -> flanc -> départ] créait presque
      // systématiquement une antenne quand le waypoint se trouvait dans la
      // direction générale de la boucle (ex. ouest de Poisy).
      const syntheticPoints = generatorFn(scale, attempt);
      const coords = userWaypoints.length
        ? insertUserWaypoints(start, syntheticPoints, userWaypoints)
        : [start, ...syntheticPoints, start];
      lastCoords = coords;
      if (userWaypoints.length) {
        RPUtils.debugLog(`Tentative ${attempt}/${maxAttempts} : ${userWaypoints.length} point(s) imposé(s) inséré(s) dans un anneau de ${syntheticPoints.length} sommet(s) (échelle ${scale.toFixed(2)}).`, 'info');
      }
      try {
        // BRouter (GET, gratuit, rapide) sert uniquement de test de forme,
        // avec le MÊME profil que celui réellement utilisé pour cet
        // itinéraire ; le vrai calcul (ORS ou BRouter selon le moteur choisi)
        // se fait séparément juste après, sur ces mêmes coordonnées.
        const preview = await RPRouting.computeRoute(coords, { name: 'aperçu boucle' }, { profile: brouterProfile, brouterProfile }, { routingEngine: 'brouter' });
        const actualKm = preview.distance / 1000;
        if (userWaypoints.length && actualKm > 0) {
          const ratio = distanceKm / actualKm;
          const relativeError = Math.abs(actualKm / distanceKm - 1);
          if (relativeError > Math.max(0.05, toleranceRatio)) {
            scale = Math.max(0.35, Math.min(3.5, scale * Math.max(0.65, Math.min(1.8, ratio ** 0.8))));
            RPUtils.debugLog(`Aperçu ${actualKm.toFixed(1)} km pour ${distanceKm} km demandés ; correction de la taille de boucle.`, 'info');
            continue;
          }
        }
        const shape = validateLoopRoute(preview.latlngs, start, direction, requireUniqueRoads);
        const passage = shape.ok ? validateUserWaypoints(preview.latlngs, userWaypoints) : shape;
        const check = passage.ok && requireUniqueRoads && userWaypoints.length
          ? validateSpurBudget(preview.latlngs, distanceKm) : passage;
        if (check.ok) {
          if (attempt > 1) RPUtils.debugLog(`Boucle valide obtenue après ${attempt} tentative(s).`, 'ok');
          return coords;
        }
        // Si la géométrie, le passage par les points imposés et la distance
        // sont corrects mais que seul le chevauchement dépasse le budget
        // strict, mémorise le meilleur candidat de secours. On continue les
        // tentatives pour essayer de faire mieux, puis on pourra proposer ce
        // candidat imparfait au lieu d'échouer totalement.
        if (passage.ok && requireUniqueRoads && userWaypoints.length) {
          const relaxed = validateSpurBudget(preview.latlngs, distanceKm, { relaxed: true });
          if (relaxed.ok) {
            const distanceError = Math.abs(actualKm - distanceKm);
            const score = relaxed.extraM + distanceError * 250;
            if (!bestFallback || score < bestFallback.score) {
              bestFallback = { coords, score, extraM: relaxed.extraM, actualKm };
              RPUtils.debugLog(`Candidat de secours mémorisé : ${actualKm.toFixed(1)} km, ${(relaxed.extraM / 1000).toFixed(1)} km de chevauchement.`, 'warn');
            }
          }
        }
        if (requireUniqueRoads && validateLoopRoute(preview.latlngs, start, direction, false).ok
            && RPOverlaps.findSegments(preview.latlngs).length) trimmableCoords = coords;
        lastReason = check.reason;
        RPUtils.debugLog(`Tentative ${attempt}/${maxAttempts} : ${check.reason} Nouvel essai…`, 'warn');
      } catch (err) {
        // Si même l'aperçu échoue (réseau, etc.), on ne bloque pas la
        // génération pour autant : on renvoie les coordonnées telles quelles.
        RPUtils.debugLog(`Aperçu de boucle impossible à valider (${err.message}), poursuite sans validation.`, 'warn');
        // Le tracé final sera contrôlé après routage ORS/BRouter dans app.js.
        return coords;
      }
    }
    if (bestFallback) {
      bestFallback.coords._rpRelaxedOverlap = true;
      bestFallback.coords._rpFallbackOverlapM = bestFallback.extraM;
      RPUtils.debugLog(`Aucune boucle parfaite trouvée : meilleur candidat conservé (${bestFallback.actualKm.toFixed(1)} km, ${(bestFallback.extraM / 1000).toFixed(1)} km de chevauchement).`, 'warn');
      return bestFallback.coords;
    }
    if (trimmableCoords && !userWaypoints.length) return trimmableCoords;
    if (userWaypoints.length || requireUniqueRoads || direction !== 'random' && direction !== 'centered')
      throw new Error(`Aucune boucle valide ne passe par tous les points choisis. ${lastReason} Modifie les points, la distance ou la direction.`);
    RPUtils.debugLog(`Aucune boucle sans aller-retour trouvée après ${maxAttempts} tentatives, utilisation de la dernière forme générée.`, 'warn');
    return lastCoords;
  }

  /**
   * Génère et valide les coordonnées d'UNE boucle pour UN itinéraire précis
   * (avec son propre profil BRouter de validation). À appeler séparément
   * pour chacun des itinéraires générés, jamais une seule fois partagée.
   */
  async function buildLoopCoordinatesForRoute(mode, start, criteria, brouterProfile, userWaypoints = []) {
    if (mode === 'random-loop') {
      return buildValidatedLoopCoordinates(
        start, criteria.distanceKm, criteria.relief,
        (scale = 1) => generateRandomLoopWaypoints(start, criteria.distanceKm * scale, criteria.relief, criteria.loopDirection),
        brouterProfile, userWaypoints.length ? 7 : 5, criteria.avoidOverlap, criteria.loopDirection, userWaypoints, criteria.toleranceRatio
      );
    }
    return buildValidatedLoopCoordinates(
      start, criteria.distanceKm, criteria.relief,
      (scale = 1, attempt = 1) => generateLoopWaypoints(start, criteria.distanceKm * scale, {
        relief: criteria.relief,
        direction: criteria.loopDirection,
        // Une graine différente par essai garantit qu'un refus pour
        // chevauchement produit réellement une autre géométrie.
        seed: Math.floor((Date.now() % 1000000) + attempt * 104729),
      }),
      brouterProfile, userWaypoints.length ? 7 : 5, criteria.avoidOverlap, criteria.loopDirection, userWaypoints, criteria.toleranceRatio
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
          const anchors = [start, ...waypoints, end];
          const detourPts = generateDetourWaypoints(start, end, detour.targetDistanceKm);
          // Assign each generated detour to the closest A→B interval; keep user anchors fixed.
          const bins = Array.from({ length: anchors.length - 1 }, () => []);
          for (const point of detourPts) {
            let best = 0, closest = Infinity;
            for (let i = 0; i < bins.length; i += 1) {
              const a = anchors[i], b = anchors[i + 1];
              const da = RPUtils.haversineDistance(a, point);
              const db = RPUtils.haversineDistance(b, point);
              const score = da + db - RPUtils.haversineDistance(a, b);
              if (score < closest) { closest = score; best = i; }
            }
            bins[best].push(point);
          }
          return anchors.flatMap((anchor, i) => i < bins.length ? [anchor, ...bins[i]] : [anchor]);
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

  return { generateLoopWaypoints, generateRandomLoopWaypoints, generateDetourWaypoints, buildCoordinatesForMode, buildLoopCoordinatesForRoute, validateLoopRoute, validateUserWaypoints, validateSpurBudget, insertUserWaypoints, buildUserGuidedLoop };
})();
