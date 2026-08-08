/**
 * app.js
 * Point d'entrée de l'application. Détient l'état applicatif (départ,
 * arrivée, points de passage, mode, dernier jeu de résultats) et relie les
 * modules entre eux : géocodage -> carte -> routing -> export -> UI.
 */

(() => {

  // À incrémenter à chaque livraison (garder synchronisé avec CACHE_NAME
  // dans service-worker.js) : permet de vérifier en un coup d'œil, via le
  // panneau de diagnostic (visible même replié), si un déploiement a bien
  // été pris en compte par le navigateur.
  const APP_VERSION = 'v18';

  const state = {
    start: null,       // { lat, lng, label }
    end: null,         // { lat, lng, label }
    waypoints: [],      // [{ lat, lng, label }]
    mode: 'point-to-point',
    results: [],        // dernier jeu de résultats [{ def, stats, quality, visible }]
  };

  /** Exécute une étape d'initialisation ; log et poursuit si elle échoue,
   * au lieu de laisser une erreur bloquer tout le reste de l'app. */
  function safeInit(label, fn) {
    try {
      fn();
    } catch (err) {
      RPUtils.debugLog(`Échec initialisation "${label}" (poursuite quand même) : ${err.message}`, 'error');
      console.error(`[RoadPlanner] Échec initialisation "${label}"`, err);
    }
  }

  function init() {
    const badge = document.getElementById('app-version-badge');
    if (badge) badge.textContent = APP_VERSION;
    RPUtils.debugLog(`Application initialisée (RoadPlanner ${APP_VERSION}).`, 'ok');

    // Chaque étape d'initialisation est isolée : si l'une échoue (ex. un
    // élément HTML manquant après un déploiement partiel/désynchronisé),
    // les autres démarrent quand même — la carte, en particulier, ne doit
    // jamais rester bloquée à cause d'un bouton annexe manquant ailleurs.
    safeInit('theme', initTheme);
    safeInit('diagnostic éléments masqués', diagnoseHiddenElements);
    safeInit('bandeau protocole', checkProtocolWarning);
    safeInit('panneau de diagnostic', wireDebugPanelToggle);
    safeInit('carte', () => RPMap.init());
    safeInit('glissement du panneau', () => RPUi.initPanelDrag());
    safeInit('onglets', () => RPUi.initTabs());
    safeInit('champs critères', () => RPUi.initCriteriaFields());
    safeInit('grille de modes', () => RPUi.initModeGrid((mode) => { state.mode = mode; }));
    safeInit('grille type de vélo', () => RPUi.initBikeTypeGrid());
    safeInit('grille transport visite citadine', () => RPUi.initCityTourTransportGrid());
    safeInit('libellé nombre de parcours', wireRouteCountLabel);
    safeInit('options détours', wireDetourOptions);
    safeInit('géocodage', wireGeocoding);
    safeInit('sélection carte', wireMapPicking);
    safeInit('menu contextuel carte', wireMapContextMenu);
    safeInit('points de passage', wireWaypoints);
    safeInit('boutons flottants', wireFabButtons);
    safeInit('bouton générer', () => {
      document.getElementById('btn-generate').addEventListener('click', handleGenerate);
    });

    registerServiceWorker();
  }

  /**
   * L'application dépend d'appels réseau (Nominatim, OpenRouteService,
   * tuiles OSM) qui échouent silencieusement ou sont bloqués (403 "Referer
   * required") quand la page est ouverte directement depuis le disque
   * (file://) plutôt que servie en http(s). On avertit clairement plutôt
   * que de laisser l'utilisateur face à un chargement infini inexpliqué.
   */
  function checkProtocolWarning() {
    if (window.location.protocol !== 'file:') return;
    const banner = document.getElementById('protocol-warning');
    banner.hidden = false;
    document.body.classList.add('has-protocol-warning');
    document.getElementById('btn-dismiss-warning').addEventListener('click', () => {
      banner.hidden = true;
      document.body.classList.remove('has-protocol-warning');
    });
  }

  /** Le panneau de diagnostic est replié par défaut : un clic sur son en-tête le déplie/replie. */
  function wireDebugPanelToggle() {
    const panel = document.getElementById('debug-panel');
    const toggleBtn = document.getElementById('debug-panel-toggle');
    toggleBtn.addEventListener('click', () => panel.classList.toggle('is-collapsed'));

    const copyBtn = document.getElementById('btn-copy-debug-log');
    if (!copyBtn) return; // index.html pas encore à jour avec ce bouton : on s'arrête proprement ici
    copyBtn.addEventListener('click', async () => {
      const text = document.getElementById('debug-log').textContent;
      const ok = await copyTextToClipboard(text);
      if (ok) {
        const original = copyBtn.textContent;
        copyBtn.textContent = 'Copié !';
        copyBtn.classList.add('is-copied');
        setTimeout(() => { copyBtn.textContent = original; copyBtn.classList.remove('is-copied'); }, 1800);
      } else {
        RPUtils.toast('Copie impossible sur ce navigateur.', { error: true });
      }
    });
  }

  /** Copie du texte dans le presse-papier, avec repli pour les contextes où l'API Clipboard est indisponible. */
  async function copyTextToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* on tente le repli ci-dessous */ }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * Vérifie l'état RÉEL (calculé par le navigateur) des éléments qui
   * devraient être masqués au chargement, pour trancher sans ambiguïté
   * si le CSS chargé est bien à jour ou si autre chose les affiche.
   */
  function diagnoseHiddenElements() {
    ['loading-overlay', 'protocol-warning'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) { RPUtils.debugLog(`Diagnostic : élément #${id} introuvable dans le DOM.`, 'error'); return; }
      const display = window.getComputedStyle(el).display;
      const visible = display !== 'none';
      RPUtils.debugLog(
        `Diagnostic #${id} : attribut hidden=${el.hidden}, display calculé="${display}" → ${visible ? 'VISIBLE (anormal si hidden=true)' : 'masqué (normal)'}`,
        visible && el.hidden ? 'error' : 'ok'
      );
    });
  }

  /** Le libellé du bouton "Générer" reflète le nombre de parcours choisi (1, 2 ou 3). */
  function wireRouteCountLabel() {
    const select = document.getElementById('select-route-count');
    const btn = document.getElementById('btn-generate');
    const updateLabel = () => {
      const n = parseInt(select.value, 10) || 3;
      btn.textContent = n === 1 ? 'Générer 1 parcours' : `Générer ${n} parcours`;
    };
    select.addEventListener('change', updateLabel);
    updateLabel();
  }

  /** État de la section détours (mode Aller A → B), lu au moment de la génération. */
  const detourState = { enabled: false, targetType: 'distance', targetValue: null };

  function wireDetourOptions() {
    const chk = document.getElementById('chk-detours');
    const optionsEl = document.getElementById('detour-options');
    const typeGrid = document.getElementById('detour-target-type-grid');
    const unitEl = document.getElementById('detour-target-unit');
    const targetInput = document.getElementById('input-detour-target');
    const hintEl = document.getElementById('detour-hint');

    chk.addEventListener('change', () => {
      detourState.enabled = chk.checked;
      optionsEl.hidden = !chk.checked;
      if (chk.checked) updateDetourHint();
    });

    typeGrid.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        typeGrid.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        detourState.targetType = btn.dataset.detourType;
        unitEl.textContent = detourState.targetType === 'time' ? 'min' : 'km';
        updateDetourHint();
      });
    });

    targetInput.addEventListener('input', () => {
      detourState.targetValue = parseFloat(targetInput.value) || null;
    });

    function updateDetourHint() {
      if (!state.start || !state.end) {
        hintEl.textContent = 'Distance directe : calculée une fois départ et arrivée renseignés.';
        return;
      }
      const directM = RPUtils.haversineDistance(
        [state.start.lat, state.start.lng], [state.end.lat, state.end.lng]
      );
      const directKm = directM / 1000;
      if (detourState.targetType === 'distance') {
        hintEl.textContent = `Distance directe (à vol d'oiseau) : ~${directKm.toFixed(1)} km. Indiquez une cible supérieure.`;
      } else {
        const criteria = RPProfiles.readCriteriaFromUI();
        const directMin = (directKm / criteria.avgSpeedKmh) * 60;
        hintEl.textContent = `Temps direct estimé : ~${Math.round(directMin)} min. Indiquez une cible supérieure.`;
      }
    }

    // Recalcule l'indice chaque fois qu'un point est choisi (recherche ou carte)
    document.getElementById('input-start').addEventListener('change', updateDetourHint);
    document.getElementById('input-end').addEventListener('change', updateDetourHint);
  }

  /** Convertit l'état de la section détours en distance cible exploitable par loops.js. */
  function buildDetourPayload(criteria) {
    if (!detourState.enabled || !detourState.targetValue || detourState.targetValue <= 0) {
      return { enabled: false, targetDistanceKm: 0 };
    }
    if (detourState.targetType === 'time') {
      const targetDistanceKm = (detourState.targetValue / 60) * criteria.avgSpeedKmh;
      return { enabled: true, targetDistanceKm };
    }
    return { enabled: true, targetDistanceKm: detourState.targetValue };
  }

  /**
   * Construit la liste des points "utiles" pour découper le tracé en
   * segments à étiqueter (une étiquette par segment, pas de points
   * synthétiques de boucle/détour). Une boucle sans point de passage n'a
   * qu'un seul segment (départ->arrivée = le tour complet).
   */
  function buildLabelBoundaryPoints(mode, start, end, waypoints) {
    switch (mode) {
      case 'point-to-point':
      case 'out-and-back':
        return end ? [start, ...waypoints, end] : [start];
      case 'loop-waypoints':
        return [start, ...waypoints, start];
      case 'loop':
      case 'random-loop':
      default:
        return [start, start];
    }
  }

  function wireGeocoding() {
    const inputStart = document.getElementById('input-start');
    const inputEnd = document.getElementById('input-end');

    RPGeocoder.attachAutocomplete(
      inputStart,
      document.getElementById('suggestions-start'),
      (result) => {
        state.start = { lat: result.lat, lng: result.lng, label: result.label };
        RPMap.setStartMarker([result.lat, result.lng]);
        RPMap.getMap().setView([result.lat, result.lng], 12);
        syncMarkerDrag('start');
      }
    );

    RPGeocoder.attachAutocomplete(
      inputEnd,
      document.getElementById('suggestions-end'),
      (result) => {
        state.end = { lat: result.lat, lng: result.lng, label: result.label };
        RPMap.setEndMarker([result.lat, result.lng]);
        syncMarkerDrag('end');
      }
    );

    const clearStartBtn = document.getElementById('btn-clear-start');
    const clearEndBtn = document.getElementById('btn-clear-end');

    // Si l'utilisateur retape/efface le champ à la main sans re-sélectionner
    // une suggestion, on invalide l'ancienne position pour ne jamais lancer
    // un calcul avec des coordonnées qui ne correspondent plus au texte affiché.
    inputStart.addEventListener('input', () => {
      if (state.start && inputStart.value !== state.start.label) {
        state.start = null;
        RPMap.clearStartMarker();
      }
      clearStartBtn.hidden = inputStart.value.length === 0;
    });
    inputEnd.addEventListener('input', () => {
      if (state.end && inputEnd.value !== state.end.label) {
        state.end = null;
        RPMap.clearEndMarker();
      }
      clearEndBtn.hidden = inputEnd.value.length === 0;
    });

    // Boutons "effacer" : vident le champ et invalident l'état en un clic
    // (réutilise la logique ci-dessus via un événement 'input' déclenché à la main).
    clearStartBtn.addEventListener('click', () => {
      inputStart.value = '';
      inputStart.dispatchEvent(new Event('input'));
      inputStart.focus();
    });
    clearEndBtn.addEventListener('click', () => {
      inputEnd.value = '';
      inputEnd.dispatchEvent(new Event('input'));
      inputEnd.focus();
    });

    // Etat initial des boutons (utile si le champ est prérempli au chargement)
    clearStartBtn.hidden = inputStart.value.length === 0;
    clearEndBtn.hidden = inputEnd.value.length === 0;
  }

  /* ======================================================================
     Fonctions partagées : définir départ / arrivée / point de passage
     (utilisées par la sélection au clic ET par le menu contextuel)
     ====================================================================== */

  /** Définit la valeur d'un champ ET déclenche 'input', pour que la logique
   * d'affichage du bouton "effacer" (centralisée dans wireGeocoding) réagisse
   * même quand le champ est rempli par programme (carte, géolocalisation...). */
  function setFieldValue(inputEl, value) {
    inputEl.value = value;
    inputEl.dispatchEvent(new Event('input'));
  }

  async function setStartPoint(latlng, label) {
    const finalLabel = label || await RPGeocoder.reverseGeocode(latlng);
    state.start = { lat: latlng[0], lng: latlng[1], label: finalLabel };
    setFieldValue(document.getElementById('input-start'), finalLabel);
    RPMap.setStartMarker(latlng);
    syncMarkerDrag('start');
  }

  async function setEndPoint(latlng, label) {
    const finalLabel = label || await RPGeocoder.reverseGeocode(latlng);
    state.end = { lat: latlng[0], lng: latlng[1], label: finalLabel };
    setFieldValue(document.getElementById('input-end'), finalLabel);
    RPMap.setEndMarker(latlng);
    syncMarkerDrag('end');
  }

  async function addWaypointPoint(latlng, label) {
    const finalLabel = label || await RPGeocoder.reverseGeocode(latlng);
    const marker = RPMap.addWaypointMarker(latlng);
    state.waypoints.push({ lat: latlng[0], lng: latlng[1], label: finalLabel, marker });
    refreshWaypointsList();
  }

  function syncMarkerDrag(which) {
    const marker = RPMap.getMarkers()[which];
    if (!marker) return;
    marker.off('dragend').on('dragend', async () => {
      const { lat, lng } = marker.getLatLng();
      const label = await RPGeocoder.reverseGeocode([lat, lng]);
      state[which] = { lat, lng, label };
      setFieldValue(document.getElementById(which === 'start' ? 'input-start' : 'input-end'), label);
    });
  }

  /* ======================================================================
     Sélection directe sur la carte (bouton "cible" à côté des champs)
     ====================================================================== */

  function wireMapPicking() {
    document.getElementById('btn-pick-start').addEventListener('click', (e) => {
      startPickMode('start', e.currentTarget);
    });
    document.getElementById('btn-pick-end').addEventListener('click', (e) => {
      startPickMode('end', e.currentTarget);
    });
  }

  function startPickMode(which, buttonEl) {
    RPUtils.toast('Touchez la carte pour choisir le point.');
    buttonEl.classList.add('is-active');
    RPUi.setPanelState('collapsed');
    RPMap.enablePickMode(which, async (latlng) => {
      buttonEl.classList.remove('is-active');
      RPUi.setPanelState('half');
      if (which === 'start') await setStartPoint(latlng);
      else await setEndPoint(latlng);
    });
  }

  /* ======================================================================
     Menu contextuel carte (clic droit desktop / appui long tactile)
     ====================================================================== */

  function wireMapContextMenu() {
    RPMap.onContextMenuSelect(async (action, latlng) => {
      if (action === 'start') {
        await setStartPoint(latlng);
        RPUtils.toast('Départ défini.');
      } else if (action === 'end') {
        await setEndPoint(latlng);
        RPUtils.toast('Arrivée définie.');
      } else if (action === 'waypoint') {
        await addWaypointPoint(latlng);
        RPUtils.toast('Point de passage ajouté.');
      }
    });
  }

  /* ======================================================================
     Points de passage
     ====================================================================== */

  function wireWaypoints() {
    document.getElementById('btn-add-waypoint').addEventListener('click', () => {
      RPUtils.toast('Touchez la carte pour ajouter un point de passage.');
      RPUi.setPanelState('collapsed');
      RPMap.enablePickMode('waypoint', async (latlng) => {
        RPUi.setPanelState('half');
        await addWaypointPoint(latlng);
      });
    });

    const waypointInput = document.getElementById('input-waypoint');
    RPGeocoder.attachAutocomplete(
      waypointInput,
      document.getElementById('suggestions-waypoint'),
      async (result) => {
        await addWaypointPoint([result.lat, result.lng], result.label);
        waypointInput.value = '';
        RPMap.getMap().panTo([result.lat, result.lng]);
      }
    );
  }

  function refreshWaypointsList() {
    RPUi.renderWaypointsList(state.waypoints, (index) => {
      const removed = state.waypoints.splice(index, 1)[0];
      if (removed?.marker) RPMap.removeWaypointMarker(removed.marker);
      refreshWaypointsList();
    });
  }

  /* ======================================================================
     Boutons flottants (localisation, fond de carte)
     ====================================================================== */

  function wireFabButtons() {
    document.getElementById('btn-locate').addEventListener('click', async () => {
      try {
        const latlng = await RPMap.locateUser();
        if (!state.start) {
          const label = await RPGeocoder.reverseGeocode(latlng);
          state.start = { lat: latlng[0], lng: latlng[1], label };
          setFieldValue(document.getElementById('input-start'), label);
          RPMap.setStartMarker(latlng);
          syncMarkerDrag('start');
        }
      } catch (err) {
        RPUtils.toast('Localisation impossible : ' + err.message, { error: true });
      }
    });

    document.getElementById('btn-layers').addEventListener('click', () => {
      const layer = RPMap.cycleBaseLayer();
      RPUtils.toast(`Fond de carte : ${layer === 'osm' ? 'OpenStreetMap' : layer === 'cyclosm' ? 'CyclOSM' : 'OpenTopoMap (relief)'}`);
    });

    document.getElementById('btn-theme').addEventListener('click', toggleTheme);
  }

  /** Applique le thème sombre (défaut) ou clair sur <html>, met à jour l'icône, et sauvegarde le choix. */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('icon-theme-dark').hidden = theme === 'light';
    document.getElementById('icon-theme-light').hidden = theme !== 'light';
    RPUtils.storage.set('rp_theme', theme);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    applyTheme(current === 'light' ? 'dark' : 'light');
  }

  /** Thème initial : préférence sauvegardée, sinon préférence système, sinon sombre par défaut. */
  function initTheme() {
    const saved = RPUtils.storage.get('rp_theme', null);
    if (saved === 'light' || saved === 'dark') {
      applyTheme(saved);
      return;
    }
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    applyTheme(prefersLight ? 'light' : 'dark');
  }

  /* ======================================================================
     Génération des 3 parcours
     ====================================================================== */

  /**
   * Flux de génération dédié au mode "Visite citadine" : recherche des
   * points d'intérêt à proximité via Overpass, sélection d'un sous-ensemble
   * bien réparti géographiquement, ordonnancement en séquence de visite,
   * puis calcul d'UN SEUL itinéraire (à pied ou à vélo tranquille) les
   * reliant. Ne passe pas par le flux standard des 3 itinéraires : le
   * concept de profils "rapide/tranquille/chemins" n'a pas de sens ici.
   */
  async function handleCityTourGenerate(startLatLng, criteria) {
    generationCancelled = false;
    const radiusKm = parseFloat(document.getElementById('range-city-radius').value) || 3;
    const stopCount = parseInt(document.getElementById('range-city-stops').value, 10) || 6;
    const transport = document.getElementById('select-city-transport').value || 'foot';

    RPUi.setLoading(true, 'Recherche des points d\'intérêt à proximité…', handleCancelGenerate);
    RPMap.clearRoutes();
    RPMap.clearPoiMarkers();

    let orderedPois;
    try {
      const pois = await RPPoi.fetchPois(startLatLng, radiusKm * 1000);
      RPUtils.debugLog(`${pois.length} point(s) d'intérêt trouvé(s) dans un rayon de ${radiusKm} km.`, 'info');
      if (!pois.length) {
        RPUi.setLoading(false);
        RPUtils.toast('Aucun point d\'intérêt trouvé dans ce rayon. Essayez un rayon plus large ou un autre endroit.', { error: true });
        return;
      }
      const selected = RPPoi.selectDistributedPois(pois, startLatLng, stopCount);
      if (!selected.length) {
        RPUi.setLoading(false);
        RPUtils.toast('Impossible de sélectionner des points suffisamment espacés. Essayez un rayon plus large.', { error: true });
        return;
      }
      orderedPois = RPPoi.orderPoisNearestNeighbor(startLatLng, selected);
      RPUtils.debugLog(`${orderedPois.length} arrêt(s) retenu(s) : ${orderedPois.map((p) => p.name).join(', ')}`, 'ok');
    } catch (err) {
      RPUi.setLoading(false);
      RPUtils.debugLog('Erreur recherche de points d\'intérêt.', 'error', err);
      RPUtils.toast(`Recherche de points d'intérêt impossible : ${err.message}`, { error: true });
      return;
    }

    if (generationCancelled) { RPUi.setLoading(false); return; }

    RPUi.setLoading(true, 'Calcul de l\'itinéraire de visite…', handleCancelGenerate);

    const cityTourDef = {
      id: 'city-tour',
      name: 'Visite citadine',
      colorHex: '#9C5FE0',
      buildOptions: () => (transport === 'foot'
        ? { profile: 'foot-walking', brouterProfile: 'shortest', avoid_features: [], weightings: {}, preference: 'recommended' }
        : { profile: 'cycling-regular', brouterProfile: 'trekking', avoid_features: ['highways'], weightings: { quiet: 0.8, green: 0.6 }, preference: 'recommended' }),
    };
    const avgSpeedKmh = transport === 'foot' ? 4.5 : Math.min(criteria.avgSpeedKmh, 16);
    const poiLatLngs = orderedPois.map((p) => [p.lat, p.lng]);
    const coordinates = [startLatLng, ...poiLatLngs, startLatLng];

    try {
      const baseOptions = cityTourDef.buildOptions();
      const options = RPProfiles.applyUserPreferences(baseOptions, criteria);
      const stats = await RPRouting.computeRoute(coordinates, cityTourDef, options, criteria);
      RPUtils.debugLog(`Visite citadine : réponse reçue (${Math.round(stats.distance)} m).`, 'ok');

      RPMap.drawRoute(cityTourDef.id, stats.latlngs, cityTourDef.colorHex, {
        avgSpeedKmh,
        boundaryPoints: [startLatLng, ...poiLatLngs, startLatLng],
        routeIndex: 0,
      });
      RPMap.showPoiMarkers(orderedPois);

      const quality = RPRouting.estimateQuality(stats, criteria, 'city-tour');
      state.results = [{ def: cityTourDef, stats, quality, visible: true, avgSpeedKmh }];

      RPUi.setPanelState('half');
      setTimeout(() => {
        RPMap.fitToRoutes();
        RPUi.switchTab('results');
      }, 350);
      renderResultsPanel();
    } catch (err) {
      RPUtils.debugLog('Erreur calcul itinéraire visite citadine.', 'error', err);
      RPUtils.toast(`Calcul de l'itinéraire impossible : ${err.message}`, { error: true });
    } finally {
      RPUi.setLoading(false);
    }
  }

  async function handleGenerate() {
    RPUtils.debugLog('Génération lancée.', 'info', {
      start: state.start, end: state.end,
      waypoints: state.waypoints.map(w => ({lat:w.lat,lng:w.lng})), mode: state.mode,
    });

    if (!state.start) {
      RPUtils.debugLog('Arrêt : aucun départ défini.', 'warn');
      RPUtils.toast('Veuillez renseigner un point de départ.', { error: true });
      RPUi.switchTab('search');
      return;
    }

    const criteria = RPProfiles.readCriteriaFromUI();
    RPUtils.debugLog('Critères lus.', 'info', criteria);

    if (criteria.routingEngine === 'ors' && !RPRouting.getApiKey()) {
      RPUtils.debugLog('Arrêt : moteur ORS forcé mais aucune clé API détectée.', 'warn');
      RPUtils.toast('Renseignez votre clé API OpenRouteService, ou choisissez BRouter/Automatique (onglet Critères).', { error: true });
      RPUi.switchTab('criteria');
      return;
    }

    const startLatLng = [state.start.lat, state.start.lng];

    if (state.mode === 'city-tour') {
      await handleCityTourGenerate(startLatLng, criteria);
      return;
    }

    const endLatLng = state.end ? [state.end.lat, state.end.lng] : null;
    const waypointsLatLng = state.waypoints.map((w) => [w.lat, w.lng]);
    const labelBoundaryPoints = buildLabelBoundaryPoints(state.mode, startLatLng, endLatLng, waypointsLatLng);
    const routeDefs = RPProfiles.getRouteDefinitions(criteria.routeCount);
    generationCancelled = false;

    const isLoopMode = state.mode === 'loop' || state.mode === 'random-loop';

    // Modes non-boucle : les coordonnées sont partagées par les 3 itinéraires
    // (pas de risque de divergence de forme selon le profil). Les boucles,
    // elles, sont générées et validées séparément pour CHAQUE itinéraire un
    // peu plus bas (un aller-retour peut être spécifique à un profil donné).
    let sharedCoordinates = null;
    if (!isLoopMode) {
      try {
        const detourPayload = buildDetourPayload(criteria);
        sharedCoordinates = await RPLoops.buildCoordinatesForMode(state.mode, {
          start: startLatLng,
          end: endLatLng,
          waypoints: waypointsLatLng,
          criteria,
          detour: detourPayload,
        });
        RPUtils.debugLog(`Coordonnées construites (${sharedCoordinates.length} points).`, 'ok');
      } catch (err) {
        RPUi.setLoading(false);
        RPUtils.debugLog('Erreur construction des coordonnées.', 'error', err);
        RPUtils.toast(err.message, { error: true });
        return;
      }
    }

    RPUi.setLoading(true, `Calcul de ${routeDefs.length} parcours en cours…`, handleCancelGenerate);
    RPMap.clearRoutes();
    const results = [];

    try {
      for (const [routeIndex, def] of routeDefs.entries()) {
        if (generationCancelled) { RPUtils.debugLog('Génération annulée par l\'utilisateur.', 'warn'); break; }
        RPUtils.debugLog(`Profil "${def.name}" : appel OpenRouteService en cours…`, 'info');
        const t0 = performance.now();
        try {
          const baseOptions = def.buildOptions(criteria);
          const options = RPProfiles.applyUserPreferences(baseOptions, criteria);

          let coordinates = sharedCoordinates;
          if (isLoopMode) {
            RPUi.setLoading(true, `Vérification de la forme — itinéraire "${def.name}"…`, handleCancelGenerate);
            coordinates = await RPLoops.buildLoopCoordinatesForRoute(state.mode, startLatLng, criteria, options.brouterProfile);
            if (generationCancelled) { RPUtils.debugLog('Génération annulée pendant la vérification de la boucle.', 'warn'); break; }
            RPUi.setLoading(true, `Calcul de ${routeDefs.length} parcours en cours…`, handleCancelGenerate);
          }

          const stats = await RPRouting.computeRoute(coordinates, def, options, criteria);
          const ms = Math.round(performance.now() - t0);
          RPUtils.debugLog(`Profil "${def.name}" : réponse reçue en ${ms} ms (${Math.round(stats.distance)} m).`, 'ok');
          const quality = RPRouting.estimateQuality(stats, criteria, def.id);

          RPMap.drawRoute(def.id, stats.latlngs, def.colorHex, {
            avgSpeedKmh: criteria.avgSpeedKmh,
            boundaryPoints: labelBoundaryPoints,
            routeIndex,
          });

          results.push({
            def,
            stats,
            quality,
            visible: true,
            avgSpeedKmh: criteria.avgSpeedKmh,
          });
        } catch (err) {
          const ms = Math.round(performance.now() - t0);
          RPUtils.debugLog(`Profil "${def.name}" : ÉCHEC après ${ms} ms.`, 'error', err);
          RPUtils.toast(`Parcours "${def.name}" indisponible : ${err.message}`, { error: true });
        }
      }
    } catch (fatalErr) {
      // Filet de sécurité absolu : même une erreur totalement imprévue ici
      // ne doit jamais laisser l'overlay de chargement bloqué à l'écran.
      RPUtils.debugLog('Erreur fatale inattendue dans la génération.', 'error', fatalErr);
      RPUtils.toast('Erreur inattendue pendant la génération. Voir le journal en bas d\'écran.', { error: true });
    } finally {
      RPUtils.debugLog('Fin de la génération, fermeture de l\'overlay.', 'info');
      RPUi.setLoading(false);
    }

    state.results = results;

    if (results.length) {
      RPUi.setPanelState('half');
      // On attend la fin de la transition CSS du panneau (~0,32s) avant de
      // recadrer la carte, sinon fitBounds mesure l'ancienne position du
      // panneau et les parcours peuvent se retrouver partiellement cachés dessous.
      setTimeout(() => {
        RPMap.fitToRoutes();
        RPUi.switchTab('results');
      }, 350);
      renderResultsPanel();
    } else {
      RPUtils.debugLog('Aucun parcours généré (tous les profils ont échoué).', 'warn');
    }
  }

  let generationCancelled = false;
  function handleCancelGenerate() {
    generationCancelled = true;
    RPUi.setLoading(false);
    RPUtils.toast('Génération annulée.');
  }

  function renderResultsPanel() {
    RPUi.renderResults(state.results, {
      onToggleVisibility: (routeId) => {
        const result = state.results.find((r) => r.def.id === routeId);
        if (!result) return;
        result.visible = !result.visible;
        RPMap.setRouteVisibility(routeId, result.visible);
        renderResultsPanel();
      },
      onExport: (routeId, format) => {
        const result = state.results.find((r) => r.def.id === routeId);
        if (!result) return;
        const filename = `RoadPlanner_${result.def.name}`;
        if (format === 'gpx') RPExport.exportGPX(result.stats, filename);
        if (format === 'tcx') RPExport.exportTCX(result.stats, filename);
        if (format === 'fit') RPExport.exportFIT(result.stats, filename);
        RPUtils.toast(`Export ${format.toUpperCase()} téléchargé.`);
      },
    });
  }

  /* ======================================================================
     PWA : enregistrement du service worker
     ====================================================================== */

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js').catch((err) => {
          console.warn('Échec de l\'enregistrement du service worker', err);
        });
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  // Filet de sécurité global : si une erreur ou une promesse rejetée non
  // gérée survient n'importe où dans l'app pendant qu'un calcul est en
  // cours, on referme l'overlay au lieu de laisser l'utilisateur bloqué
  // sans aucune explication.
  window.addEventListener('unhandledrejection', (event) => {
    RPUtils.debugLog('Promesse rejetée non gérée.', 'error', event.reason);
    const overlay = document.getElementById('loading-overlay');
    if (overlay && !overlay.hidden) {
      RPUi.setLoading(false);
      RPUtils.toast('Erreur inattendue (voir le journal en bas d\'écran). Réessayez.', { error: true });
    }
  });
  window.addEventListener('error', (event) => {
    RPUtils.debugLog('Erreur JS non gérée.', 'error', event.error || event.message);
  });
})();
