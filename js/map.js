/**
 * map.js
 * Encapsule toute l'interaction avec Leaflet : initialisation, fonds de
 * carte, marqueurs (départ / arrivée / points de passage), tracé des
 * polylignes de parcours et gestion du clic pour sélection de point.
 */

const RPMap = (() => {

  let map = null;
  let baseLayers = {};
  let currentBaseLayerKey = 'osm';
  let markers = { start: null, end: null, waypoints: [] };
  let routeLayers = {}; // { routeId: L.LayerGroup }
  let routeGeometries = {}; // { routeId: { latlngs, color } } — pour détecter les chevauchements entre tracés
  let pickMode = null; // 'start' | 'end' | 'waypoint' | null
  let onPickCallback = null;

  function init() {
    map = L.map('map', {
      zoomControl: false,
      attributionControl: true,
      minZoom: 5,
      maxZoom: 19,
    }).setView([45.75, 4.85], 12); // Lyon / région Bugey par défaut, cohérent avec le contexte utilisateur

    baseLayers.osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    });

    baseLayers.cyclosm = L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors, tuiles CyclOSM',
      maxZoom: 20,
    });

    baseLayers.topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors, style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
      maxZoom: 17,
    });

    baseLayers[currentBaseLayerKey].addTo(map);

    let tileErrorNotified = false;
    map.on('tileerror', () => {
      if (tileErrorNotified) return;
      tileErrorNotified = true;
      RPUtils.toast('Fond de carte indisponible (serveur de tuiles saturé ou bloqué). Essayez un autre fond via le bouton calques.', { error: true, duration: 5000 });
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    map.on('click', (e) => {
      if (pickMode && typeof onPickCallback === 'function') {
        onPickCallback([e.latlng.lat, e.latlng.lng]);
      }
    });

    wireContextMenu(map);

    return map;
  }

  /* ======================================================================
     Menu contextuel carte : clic droit (desktop) ou appui long (tactile)
     pour définir rapidement départ / arrivée / point de passage sans passer
     par la recherche.
     ====================================================================== */

  let contextMenuCallback = null;

  /** Enregistre la fonction appelée quand l'utilisateur choisit une action du menu contextuel. */
  function onContextMenuSelect(callback) {
    contextMenuCallback = callback;
  }

  function wireContextMenu(map) {
    // Desktop : clic droit natif Leaflet.
    map.on('contextmenu', (e) => {
      showContextMenu(e.latlng);
    });

    // Mobile : pas d'événement "contextmenu" au toucher, on détecte
    // l'appui long nous-mêmes (maintien > 550ms sans déplacement notable).
    const mapEl = map.getContainer();
    let pressTimer = null;
    let pressStartPoint = null;
    let longPressLatLng = null;

    mapEl.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      pressStartPoint = { x: touch.clientX, y: touch.clientY };
      const containerPoint = map.mouseEventToContainerPoint(touch);
      longPressLatLng = map.containerPointToLatLng(containerPoint);
      pressTimer = setTimeout(() => {
        if (longPressLatLng) {
          if (navigator.vibrate) navigator.vibrate(15);
          showContextMenu(longPressLatLng);
        }
      }, 550);
    }, { passive: true });

    mapEl.addEventListener('touchmove', (e) => {
      if (!pressStartPoint || !e.touches.length) return;
      const touch = e.touches[0];
      const dist = Math.hypot(touch.clientX - pressStartPoint.x, touch.clientY - pressStartPoint.y);
      if (dist > 12) { clearTimeout(pressTimer); pressTimer = null; }
    }, { passive: true });

    ['touchend', 'touchcancel'].forEach((evt) => {
      mapEl.addEventListener(evt, () => {
        clearTimeout(pressTimer);
        pressTimer = null;
        pressStartPoint = null;
      }, { passive: true });
    });
  }

  function showContextMenu(latlng) {
    const html = `
      <div class="map-context-menu">
        <button type="button" data-action="start">📍 Définir comme départ</button>
        <button type="button" data-action="end">🏁 Définir comme arrivée</button>
        <button type="button" data-action="waypoint">➕ Ajouter comme point de passage</button>
      </div>`;
    const popup = L.popup({ closeButton: false, className: 'rp-context-popup', offset: [0, -4], autoPan: true })
      .setLatLng(latlng)
      .setContent(html)
      .openOn(map);

    // Le contenu HTML n'existe dans le DOM qu'une fois le popup ouvert.
    setTimeout(() => {
      const el = popup.getElement();
      if (!el) return;
      el.querySelectorAll('button[data-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
          map.closePopup(popup);
          if (typeof contextMenuCallback === 'function') {
            contextMenuCallback(btn.dataset.action, [latlng.lat, latlng.lng]);
          }
        });
      });
    }, 0);
  }

  function cycleBaseLayer() {
    const order = ['osm', 'cyclosm', 'topo'];
    const currentIndex = order.indexOf(currentBaseLayerKey);
    const next = order[(currentIndex + 1) % order.length];
    map.removeLayer(baseLayers[currentBaseLayerKey]);
    baseLayers[next].addTo(map);
    currentBaseLayerKey = next;
    return next;
  }

  function makePinIcon(cssClass) {
    return L.divIcon({
      className: '',
      html: `<div class="rp-marker-pin ${cssClass}"></div>`,
      iconSize: cssClass === 'waypoint' ? [20, 20] : [26, 26],
      iconAnchor: cssClass === 'waypoint' ? [10, 20] : [13, 26],
    });
  }

  function setStartMarker([lat, lng]) {
    if (markers.start) map.removeLayer(markers.start);
    markers.start = L.marker([lat, lng], { icon: makePinIcon('start'), draggable: true }).addTo(map);
    return markers.start;
  }

  function setEndMarker([lat, lng]) {
    if (markers.end) map.removeLayer(markers.end);
    markers.end = L.marker([lat, lng], { icon: makePinIcon('end'), draggable: true }).addTo(map);
    return markers.end;
  }

  function addWaypointMarker([lat, lng]) {
    const marker = L.marker([lat, lng], { icon: makePinIcon('waypoint'), draggable: true }).addTo(map);
    markers.waypoints.push(marker);
    return marker;
  }

  function removeWaypointMarker(marker) {
    map.removeLayer(marker);
    markers.waypoints = markers.waypoints.filter((m) => m !== marker);
  }

  function clearStartMarker() {
    if (markers.start) { map.removeLayer(markers.start); markers.start = null; }
  }

  function clearEndMarker() {
    if (markers.end) { map.removeLayer(markers.end); markers.end = null; }
  }

  function clearMarkers() {
    if (markers.start) map.removeLayer(markers.start);
    if (markers.end) map.removeLayer(markers.end);
    markers.waypoints.forEach((m) => map.removeLayer(m));
    markers = { start: null, end: null, waypoints: [] };
  }

  /* ======================================================================
     Marqueurs de points d'intérêt (mode Visite citadine)
     ====================================================================== */

  let poiMarkers = [];

  /** Affiche les POI sélectionnés sur la carte, numérotés dans l'ordre de visite. */
  function showPoiMarkers(pois) {
    clearPoiMarkers();
    poiMarkers = pois.map((poi, i) => {
      const icon = L.divIcon({
        className: '',
        html: `<div class="rp-poi-marker">${i + 1}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      const marker = L.marker([poi.lat, poi.lng], { icon });
      marker.bindPopup(`<strong>${escapePopupHtml(poi.name)}</strong><br>${escapePopupHtml(poi.categoryLabel)}`);
      marker.addTo(map);
      return marker;
    });
    return poiMarkers;
  }

  function clearPoiMarkers() {
    poiMarkers.forEach((m) => map.removeLayer(m));
    poiMarkers = [];
  }

  function escapePopupHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** Active le mode "sélection sur carte" : le prochain clic déclenche callback([lat,lng]). */
  function enablePickMode(mode, callback) {
    pickMode = mode;
    onPickCallback = (latlng) => {
      callback(latlng);
      pickMode = null;
      onPickCallback = null;
      document.getElementById('map').style.cursor = '';
    };
    document.getElementById('map').style.cursor = 'crosshair';
  }

  function disablePickMode() {
    pickMode = null;
    onPickCallback = null;
    document.getElementById('map').style.cursor = '';
  }

  /**
   * Construit UNE étiquette km/temps par segment "utile" (départ->point de
   * passage, point de passage->point de passage, point de passage->arrivée,
   * ou simplement départ->arrivée s'il n'y a aucun point de passage) plutôt
   * que des étiquettes à intervalles fixes le long du tracé. boundaryPoints
   * est la liste ordonnée des points définis par l'utilisateur (pas les
   * points synthétiques générés pour les boucles/détours).
   */
  function buildRouteLabelMarkers(latlngs, color, avgSpeedKmh, boundaryPoints, routeIndex = 0) {
    const n = latlngs.length;
    if (n < 2 || !boundaryPoints || boundaryPoints.length < 2) return [];

    const cumDist = [0];
    for (let i = 1; i < n; i += 1) {
      cumDist.push(cumDist[i - 1] + RPUtils.haversineDistance(latlngs[i - 1], latlngs[i]));
    }

    // Pour chaque point défini par l'utilisateur, trouve l'index du point du
    // tracé réel le plus proche (le moteur de routage "colle" le point au réseau).
    let boundaryIndices = boundaryPoints.map((bp) => {
      let closestIdx = 0;
      let closestDist = Infinity;
      for (let i = 0; i < n; i += 1) {
        const d = RPUtils.haversineDistance(bp, latlngs[i]);
        if (d < closestDist) { closestDist = d; closestIdx = i; }
      }
      return closestIdx;
    }).sort((a, b) => a - b);

    // Dédoublonne les index identiques (ex. boucle sans point de passage :
    // départ et arrivée sont le même point géographique -> même index trouvé).
    boundaryIndices = [...new Set(boundaryIndices)];
    if (boundaryIndices.length < 2) boundaryIndices = [0, n - 1];

    // Décalage vertical fixe (en pixels écran, donc stable quel que soit le
    // zoom) selon l'itinéraire : évite que les étiquettes de 2 tracés qui
    // partagent la même route ne s'affichent exactement au même endroit.
    const labelOffsetPx = routeIndex * 42;

    const markers = [];
    for (let s = 0; s < boundaryIndices.length - 1; s += 1) {
      const idxA = boundaryIndices[s];
      const idxB = boundaryIndices[s + 1];
      if (idxB <= idxA) continue;
      const segDistM = cumDist[idxB] - cumDist[idxA];
      if (segDistM < 200) continue; // segment trop court pour justifier une étiquette
      const segKm = segDistM / 1000;
      const segMinutes = (segKm / avgSpeedKmh) * 60;
      const midIdx = idxA + Math.floor((idxB - idxA) / 2);
      const text = `${segKm.toFixed(1)} km · ${RPUtils.formatDuration(segMinutes * 60)}`;
      const icon = L.divIcon({
        className: '',
        html: `<div class="rp-route-label" style="--label-color:${color}; --label-offset:${labelOffsetPx}px">${text}</div>`,
        iconSize: null,
        iconAnchor: [0, 0],
      });
      markers.push(L.marker(latlngs[midIdx], { icon, interactive: false, keyboard: false }));
    }
    return markers;
  }

  /**
   * Détecte les portions de latlngsA géographiquement très proches d'un
   * autre tracé déjà affiché (même route empruntée par les deux). Renvoie
   * une liste de [indexDébut, indexFin] dans latlngsA. Comparaison sur un
   * échantillonnage (pas tous les points) pour rester rapide.
   */
  function detectOverlapRanges(latlngsA, latlngsB, thresholdMeters = 18, stride = 4) {
    const n = latlngsA.length;
    if (n < 4 || latlngsB.length < 4) return [];
    const flags = new Array(n).fill(false);
    const sampleIdx = [];
    for (let i = 0; i < n; i += stride) sampleIdx.push(i);
    if (sampleIdx[sampleIdx.length - 1] !== n - 1) sampleIdx.push(n - 1);

    sampleIdx.forEach((i) => {
      const pt = latlngsA[i];
      let minD = Infinity;
      for (let j = 0; j < latlngsB.length; j += stride) {
        const d = RPUtils.haversineDistance(pt, latlngsB[j]);
        if (d < minD) minD = d;
        if (minD < thresholdMeters) break;
      }
      flags[i] = minD < thresholdMeters;
    });
    // Remplit les points entre deux échantillons avec le dernier drapeau connu
    let lastFlag = flags[sampleIdx[0]];
    let lastIdx = sampleIdx[0];
    for (let k = 1; k < sampleIdx.length; k += 1) {
      const idx = sampleIdx[k];
      for (let f = lastIdx; f < idx; f += 1) flags[f] = lastFlag;
      lastFlag = flags[idx];
      lastIdx = idx;
    }
    flags[n - 1] = lastFlag;

    const ranges = [];
    let start = null;
    for (let i = 0; i < n; i += 1) {
      if (flags[i] && start === null) start = i;
      if (!flags[i] && start !== null) { ranges.push([start, i - 1]); start = null; }
    }
    if (start !== null) ranges.push([start, n - 1]);
    return ranges.filter(([s, e]) => e - s >= 2);
  }

  /** Dessine (ou remplace) le tracé d'un parcours : liseré de contour sombre
   * pour la lisibilité, étiquettes km/temps par segment utilisateur, et
   * superposition en tirets de la couleur d'un autre tracé déjà affiché
   * partout où les deux empruntent la même route (sinon la couleur du dessus
   * masquerait complètement celle du dessous). */
  function drawRoute(routeId, latlngs, color, options = {}) {
    if (routeLayers[routeId]) {
      map.removeLayer(routeLayers[routeId]);
    }
    const weight = options.weight || 5;
    const outline = L.polyline(latlngs, {
      color: '#0B0D0F',
      weight: weight + 4,
      opacity: 0.5,
      lineJoin: 'round',
      lineCap: 'round',
    });
    const line = L.polyline(latlngs, {
      color,
      weight,
      opacity: options.opacity ?? 1,
      lineJoin: 'round',
      lineCap: 'round',
    });

    const layers = [outline, line];

    // Chevauchement avec les tracés déjà affichés : superpose la couleur de
    // l'autre tracé en tirets sur les portions communes.
    Object.entries(routeGeometries).forEach(([otherId, other]) => {
      if (otherId === routeId) return;
      const ranges = detectOverlapRanges(latlngs, other.latlngs);
      ranges.forEach(([s, e]) => {
        const subPath = latlngs.slice(s, e + 1);
        layers.push(L.polyline(subPath, {
          color: other.color,
          weight: Math.max(2, weight - 2),
          opacity: 0.95,
          dashArray: '7 9',
          lineCap: 'butt',
        }));
      });
    });

    const labelMarkers = options.avgSpeedKmh && options.boundaryPoints
      ? buildRouteLabelMarkers(latlngs, color, options.avgSpeedKmh, options.boundaryPoints, options.routeIndex || 0)
      : [];
    layers.push(...labelMarkers);

    // featureGroup (pas layerGroup) : garantit une méthode getBounds()
    // fiable une fois ce groupe imbriqué dans le featureGroup englobant de
    // fitToRoutes() — un simple layerGroup ne l'implémente pas de façon
    // fiable une fois imbriqué, ce qui provoquait un plantage silencieux
    // ("getLatLng is not a function") pile au moment du recadrage.
    const group = L.featureGroup(layers);
    if (options.visible !== false) group.addTo(map);
    routeLayers[routeId] = group;
    routeGeometries[routeId] = { latlngs, color };
    return group;
  }

  function setRouteVisibility(routeId, visible) {
    const layer = routeLayers[routeId];
    if (!layer) return;
    if (visible && !map.hasLayer(layer)) layer.addTo(map);
    if (!visible && map.hasLayer(layer)) map.removeLayer(layer);
  }

  function clearRoutes() {
    Object.values(routeLayers).forEach((layer) => map.removeLayer(layer));
    routeLayers = {};
    routeGeometries = {};
  }

  /**
   * Calcule un padding de recadrage qui tient compte de la zone de l'écran
   * réellement masquée par le panneau (bottom-sheet sur mobile, sidebar fixe
   * sur desktop), pour que les parcours ne soient jamais recadrés en partie
   * sous le panneau, invisibles pour l'utilisateur.
   */
  function getOcclusionAwarePadding() {
    const panel = document.getElementById('panel');
    if (!panel) return { padding: [40, 40] };
    const rect = panel.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Sidebar desktop : panneau plein hauteur, collé à gauche.
    if (rect.height >= vh - 2 && rect.left <= 1) {
      const leftPad = rect.width + 24;
      return { paddingTopLeft: [leftPad, 24], paddingBottomRight: [24, 24] };
    }

    // Bottom-sheet mobile : panneau pleine largeur, occulte tout ce qui est
    // sous rect.top. On ajoute une marge pour les FAB et la barre de diagnostic.
    if (rect.width >= vw - 2) {
      const bottomPad = Math.max(24, vh - rect.top + 44);
      return { paddingTopLeft: [24, 24], paddingBottomRight: [24, bottomPad] };
    }

    return { padding: [40, 40] };
  }

  function fitToRoutes() {
    const layers = Object.values(routeLayers);
    if (!layers.length) return;
    const group = L.featureGroup(layers);
    map.fitBounds(group.getBounds(), getOcclusionAwarePadding());
  }

  function fitToMarkers() {
    const pts = [];
    if (markers.start) pts.push(markers.start.getLatLng());
    if (markers.end) pts.push(markers.end.getLatLng());
    markers.waypoints.forEach((m) => pts.push(m.getLatLng()));
    if (pts.length < 2) return;
    map.fitBounds(L.latLngBounds(pts), getOcclusionAwarePadding());
  }

  function locateUser() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Géolocalisation non disponible sur cet appareil.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const latlng = [pos.coords.latitude, pos.coords.longitude];
          map.setView(latlng, 14);
          resolve(latlng);
        },
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  }

  return {
    init,
    getMap: () => map,
    cycleBaseLayer,
    setStartMarker,
    setEndMarker,
    addWaypointMarker,
    removeWaypointMarker,
    clearStartMarker,
    clearEndMarker,
    clearMarkers,
    showPoiMarkers,
    clearPoiMarkers,
    getMarkers: () => markers,
    enablePickMode,
    onContextMenuSelect,
    disablePickMode,
    drawRoute,
    setRouteVisibility,
    clearRoutes,
    fitToRoutes,
    fitToMarkers,
    locateUser,
  };
})();
