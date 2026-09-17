/**
 * Détection des antennes involontaires : deux passages sur la même chaussée
 * avec un demi-tour entre eux. Les trajets aller-retour choisis par l'utilisateur
 * ne sont jamais proposés à la découpe.
 */
const RPOverlaps = (() => {
  const METERS_PER_DEGREE = 111195;

  function distances(points) {
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) {
      cumulative.push(cumulative[i - 1] + RPUtils.haversineDistance(points[i - 1], points[i]));
    }
    return cumulative;
  }

  function positionAt(points, cumulative, target) {
    let lo = 0, hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (cumulative[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return points[0];
    const span = cumulative[lo] - cumulative[lo - 1];
    const f = span > 0 ? Math.max(0, Math.min(1, (target - cumulative[lo - 1]) / span)) : 0;
    return [points[lo - 1][0] + f * (points[lo][0] - points[lo - 1][0]),
      points[lo - 1][1] + f * (points[lo][1] - points[lo - 1][1])];
  }

  function isReturnOnSameRoad(points, cumulative, i, j, thresholdM, minDistanceM) {
    const span = cumulative[j] - cumulative[i];
    if (span < minDistanceM) return false;
    let matches = 0;
    for (let sample = 1; sample <= 7; sample++) {
      const delta = (span / 2) * (sample / 8);
      const outbound = positionAt(points, cumulative, cumulative[i] + delta);
      const inbound = positionAt(points, cumulative, cumulative[j] - delta);
      if (RPUtils.haversineDistance(outbound, inbound) < Math.max(18, thresholdM * 1.8)) matches++;
    }
    return matches >= 6;
  }

  function findSegments(points, { thresholdM = 22, minDistanceM = 350, maxDistanceM = Infinity, maxPoints = 20000 } = {}) {
    if (!Array.isArray(points) || points.length < 8 || points.length > maxPoints) return [];
    const cumulative = distances(points);
    const total = cumulative[cumulative.length - 1];
    const latScale = METERS_PER_DEGREE;
    const lonScale = METERS_PER_DEGREE * Math.max(0.1, Math.cos(points[0][0] * Math.PI / 180));
    const cellSize = thresholdM * 1.5;
    const key = (x, y) => `${x}:${y}`;
    const cells = new Map();
    points.forEach((point, i) => {
      const x = Math.floor(point[1] * lonScale / cellSize);
      const y = Math.floor(point[0] * latScale / cellSize);
      const k = key(x, y);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(i);
    });
    const segments = [];
    let i = 0;
    while (i < points.length - 7) {
      const x = Math.floor(points[i][1] * lonScale / cellSize);
      const y = Math.floor(points[i][0] * latScale / cellSize);
      const candidates = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        candidates.push(...(cells.get(key(x + dx, y + dy)) || []));
      }
      candidates.sort((a, b) => a - b);
      let match = null;
      for (const j of candidates) {
        if (j < i + 3) continue;
        const traveled = cumulative[j] - cumulative[i];
        if (traveled < minDistanceM || traveled > Math.min(maxDistanceM, total * 0.65)) continue;
        const gapM = RPUtils.haversineDistance(points[i], points[j]);
        if (gapM > thresholdM) continue;
        if (!isReturnOnSameRoad(points, cumulative, i, j, thresholdM, minDistanceM)) continue;
        match = { startIndex: i, endIndex: j, removedDistanceM: traveled - gapM };
        break;
      }
      if (match) { segments.push(match); i = match.endIndex + 1; }
      else i++;
    }
    return segments;
  }

  function trimStats(stats, segment) {
    const points = stats.latlngs;
    const { startIndex: i, endIndex: j } = segment;
    if (i < 0 || j <= i + 2 || j >= points.length) throw new Error('Ce tronçon n’est plus disponible.');
    if (RPUtils.haversineDistance(points[i], points[j]) > 35) throw new Error('Les deux extrémités ne se rejoignent pas sur la carte.');
    const newPoints = [...points.slice(0, i + 1), ...points.slice(j)];
    const raw = stats.raw?.geometry?.coordinates;
    if (raw && raw.length !== points.length) throw new Error('Le profil d’altitude ne correspond pas au tracé.');
    const newRaw = raw ? [...raw.slice(0, i + 1), ...raw.slice(j)] : null;
    const oldDistance = stats.distance;
    const newDistance = distances(newPoints).at(-1);
    const ratio = oldDistance > 0 ? newDistance / oldDistance : 1;
    stats.latlngs = newPoints;
    stats.distance = newDistance;
    stats.duration = (stats.duration || 0) * ratio;
    if (newRaw) {
      stats.raw.geometry.coordinates = newRaw;
      if (newRaw.some(c => Number.isFinite(c[2]))) {
        let ascent = 0, descent = 0;
        for (let k = 1; k < newRaw.length; k++) {
          if (!Number.isFinite(newRaw[k][2]) || !Number.isFinite(newRaw[k - 1][2])) continue;
          const diff = newRaw[k][2] - newRaw[k - 1][2];
          if (diff > 0) ascent += diff;
          else descent -= diff;
        }
        stats.ascent = ascent;
        stats.descent = descent;
      } else {
        stats.ascent = null;
        stats.descent = null;
      }
      if (stats.raw.properties?.summary) {
        stats.raw.properties.summary.distance = newDistance;
        stats.raw.properties.summary.duration = stats.duration;
      }
    }
    // Statistiques de surface/voirie ORS fondées sur les anciens index.
    // Elles deviennent inconnues jusqu'au recalcul complet par le routeur.
    for (const key of ['cyclewayShare', 'smallRoadsShare', 'majorRoadsShare', 'majorRoadCrossings', 'unpavedShare']) stats[key] = null;
    return Math.max(0, oldDistance - newDistance);
  }

  /** Coupe seulement les antennes COURTES et pratiquement superposées.
   * Les longs allers-retours restent manuels, et la forme volontaire A→B→A
   * n'appelle jamais cette fonction. Les index sont recalculés après chaque
   * coupe ; chaque boucle reparcourt le nouveau tracé et son profil d'altitude.
   */
  function trimShortSpurs(stats, { maxCuts = 4, maxSpurM = 1400 } = {}) {
    let removedM = 0, cuts = 0;
    for (let attempt = 0; attempt < maxCuts; attempt++) {
      const segment = findSegments(stats.latlngs, { thresholdM: 14, minDistanceM: 120, maxDistanceM: maxSpurM + 16 })
        .find(s => s.removedDistanceM <= maxSpurM
          && RPUtils.haversineDistance(stats.latlngs[s.startIndex], stats.latlngs[s.endIndex]) <= 16);
      if (!segment) break;
      removedM += trimStats(stats, segment);
      cuts++;
    }
    return { cuts, removedM };
  }

  return { findSegments, trimStats, trimShortSpurs };
})();
