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
  // Nouveau schéma de version à partir d'ici : n'incrémenter le chiffre
  // avant la virgule (ex. 2.0 -> 3.0) que pour de GROS changements comme ce
  // lot-ci. Petites retouches -> 2.01, 2.02... Changements intermédiaires ->
  // 2.1, 2.11...
  const APP_VERSION = '2.9.0';

  const state = {
    start: null,       // { lat, lng, label }
    end: null,         // { lat, lng, label }
    insertionIndex: null,
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
    safeInit('suite Tempo', initSuiteMenu);
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
    safeInit('indice durée visite citadine', wireCityTourDurationHint);
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
    const singleTypeGroup = document.getElementById('single-route-type-field-group');
    const updateLabel = () => {
      const n = parseInt(select.value, 10) || 3;
      btn.textContent = n === 1 ? 'Générer 1 parcours' : `Générer ${n} parcours`;
      singleTypeGroup.style.display = n === 1 ? '' : 'none';
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
      case 'loop':
      case 'random-loop':
        return [start, ...waypoints, start];
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
      inputStart.blur();
    });
    clearEndBtn.addEventListener('click', () => {
      inputEnd.value = '';
      inputEnd.dispatchEvent(new Event('input'));
      inputEnd.blur();
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
    const index = state.insertionIndex === null ? state.waypoints.length : Math.min(state.insertionIndex, state.waypoints.length);
    state.waypoints.splice(index, 0, { lat: latlng[0], lng: latlng[1], label: finalLabel, marker });
    state.insertionIndex = null;
    marker.on('dragend', async () => {
      const pos = marker.getLatLng();
      const wp = state.waypoints.find((entry) => entry.marker === marker);
      if (!wp) return;
      wp.lat = pos.lat; wp.lng = pos.lng;
      wp.label = await RPGeocoder.reverseGeocode([pos.lat, pos.lng]);
      refreshWaypointsList();
    });
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
    }, (from, to) => {
      if (to < 0 || to >= state.waypoints.length) return;
      state.waypoints.splice(to, 0, state.waypoints.splice(from, 1)[0]);
      state.insertionIndex = null;
      refreshWaypointsList();
    }, (index) => {
      state.insertionIndex = index;
      refreshWaypointsList();
      document.getElementById('input-waypoint').focus();
    });
    const hint = document.getElementById('waypoint-insertion-hint');
    hint.textContent = state.insertionIndex === null
      ? 'Le prochain point sera ajouté à la fin.'
      : `Le prochain point sera inséré avant le point ${state.insertionIndex + 1}.`;
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

    document.getElementById('btn-theme').addEventListener('click', toggleTheme);
    document.getElementById('btn-settings').addEventListener('click', () => RPUi.switchTab('criteria'));
  }

  function initSuiteMenu() {
    const toggle = document.getElementById('suite-toggle');
    const menu = document.getElementById('suite-menu');
    toggle.addEventListener('click', () => {
      menu.hidden = !menu.hidden;
      toggle.setAttribute('aria-expanded', String(!menu.hidden));
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('#suite-switcher')) {
        menu.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
    });
  }

  /** Trois choix explicites ; « système » suit automatiquement les changements du téléphone. */
  function applyTheme(preference) {
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    const resolved = preference === 'system' ? (prefersLight ? 'light' : 'dark') : preference;
    document.documentElement.setAttribute('data-theme', resolved);
    const button = document.getElementById('btn-theme');
    const preferenceLabel = preference === 'system' ? 'système' : preference === 'light' ? 'clair' : 'sombre';
    button.title = `Thème : ${preferenceLabel}. Toucher pour changer.`;
    button.setAttribute('aria-label', button.title);
    RPUtils.storage.set('rp_theme', preference);
  }

  function toggleTheme() {
    const current = RPUtils.storage.get('rp_theme', 'system');
    applyTheme(current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system');
  }

  function initTheme() {
    const saved = RPUtils.storage.get('rp_theme', 'system');
    applyTheme(['system', 'light', 'dark'].includes(saved) ? saved : 'system');
    window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
      if (RPUtils.storage.get('rp_theme', 'system') === 'system') applyTheme('system');
    });
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
  /** Met à jour l'indice sous le curseur de durée de visite citadine (rayon/arrêts estimés). */
  function wireCityTourDurationHint() {
    const durationInput = document.getElementById('range-city-duration');
    const transportSelect = document.getElementById('select-city-transport');
    const hintEl = document.getElementById('city-duration-hint');

    function update() {
      const durationHours = parseFloat(durationInput.value) || 2;
      const transport = transportSelect.value || 'foot';
      const criteria = RPProfiles.readCriteriaFromUI();
      const { stopCount, radiusKm } = estimateCityTourParams(durationHours, transport, criteria.avgSpeedKmh);
      hintEl.textContent = `Environ ${stopCount} arrêts dans un rayon de ~${radiusKm.toFixed(1)} km (estimation, ajustée selon le déplacement choisi).`;
    }

    durationInput.addEventListener('input', update);
    document.getElementById('city-tour-transport-grid').addEventListener('click', () => setTimeout(update, 0));
    update();
  }

  /**
   * Traduit une durée de visite souhaitée (heures) en rayon de recherche et
   * nombre d'arrêts. Estimation grossière (comme la distance des boucles) :
   * ~12 min de visite par arrêt + ~8 min de trajet entre deux arrêts.
   */
  function estimateCityTourParams(durationHours, transport, userSpeedKmh) {
    const speedKmh = transport === 'foot' ? 4.5 : Math.min(userSpeedKmh, 16);
    const totalMinutes = durationHours * 60;
    const dwellPlusTravelPerStop = 12 + 8; // min : temps sur place + trajet vers l'arrêt suivant
    const stopCount = Math.max(3, Math.min(12, Math.round(totalMinutes / dwellPlusTravelPerStop)));
    const radiusKm = Math.max(1, Math.min(8, (speedKmh * (totalMinutes / 60)) / 4));
    return { stopCount, radiusKm, speedKmh };
  }

  async function handleCityTourGenerate(startLatLng, criteria) {
    generationCancelled = false;
    const durationHours = parseFloat(document.getElementById('range-city-duration').value) || 2;
    const transport = document.getElementById('select-city-transport').value || 'foot';
    const { stopCount, radiusKm } = estimateCityTourParams(durationHours, transport, criteria.avgSpeedKmh);
    RPUtils.debugLog(`Visite citadine : durée souhaitée ${durationHours} h -> ~${stopCount} arrêts dans un rayon de ~${radiusKm.toFixed(1)} km (estimation).`, 'info');

    RPUi.setLoading(true, 'Recherche des points d\'intérêt à proximité…', handleCancelGenerate);
    clearOverlapHighlights();
    RPMap.clearRoutes();
    RPMap.clearPoiMarkers();

    let orderedPois;
    try {
      const pois = await RPPoi.fetchPois(startLatLng, radiusKm * 1000);
      RPUtils.debugLog(`${pois.length} point(s) d'intérêt trouvé(s) dans un rayon de ${radiusKm.toFixed(1)} km.`, 'info');
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
      state.results = [{ def: cityTourDef, stats, quality, visible: true, avgSpeedKmh, pois: orderedPois }];

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
    const routeDefs = RPProfiles.getRouteDefinitions(criteria.routeCount, criteria.singleRouteType);
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
    clearOverlapHighlights();
    RPMap.clearRoutes();
    RPMap.clearPoiMarkers(); // efface les marqueurs numérotés d'une éventuelle visite citadine précédente
    const results = [];

    try {
      for (const [routeIndex, def] of routeDefs.entries()) {
        if (generationCancelled) { RPUtils.debugLog('Génération annulée par l\'utilisateur.', 'warn'); break; }
        const t0 = performance.now();
        try {
          const baseOptions = def.buildOptions(criteria);
          const options = RPProfiles.applyUserPreferences(baseOptions, criteria);
          const directBRouter = criteria.routingEngine === 'brouter'
            || (criteria.routingEngine === 'auto'
              && options.profile === 'cycling-road'
              && options.avoid_features?.includes('highways'));
          const engineLabel = criteria.routingEngine === 'ors'
            ? 'OpenRouteService'
            : directBRouter
              ? 'BRouter'
              : 'OpenRouteService (repli BRouter si nécessaire)';
          RPUtils.debugLog(`Profil "${def.name}" : appel ${engineLabel} en cours…`, 'info');

          let stats = null;
          let bestRoutedFallback = null;
          const finalAttempts = isLoopMode && waypointsLatLng.length ? 4 : isLoopMode ? 2 : 1;
          let correctedDistanceKm = criteria.distanceKm;
          for (let attempt = 1; attempt <= finalAttempts; attempt += 1) {
            let coordinates = sharedCoordinates;
            if (isLoopMode) {
              RPUi.setLoading(true, `Vérification de la forme — itinéraire "${def.name}"…`, handleCancelGenerate);
              coordinates = await RPLoops.buildLoopCoordinatesForRoute(state.mode, startLatLng,
                { ...criteria, distanceKm: correctedDistanceKm }, options.brouterProfile, waypointsLatLng);
              if (generationCancelled) break;
              RPUi.setLoading(true, `Calcul de ${routeDefs.length} parcours en cours…`, handleCancelGenerate);
            }
            let candidate;
            try {
              candidate = await RPRouting.computeRoute(coordinates, def, options, criteria);
            } catch (routeErr) {
              if (bestRoutedFallback) {
                stats = bestRoutedFallback.candidate;
                RPUtils.debugLog(`Moteur indisponible à l'essai ${attempt}/${finalAttempts} (${routeErr.message}) : meilleur tracé déjà calculé conservé (${(stats.distance / 1000).toFixed(1)} km).`, 'warn');
                break;
              }
              throw routeErr;
            }
            if (isLoopMode && waypointsLatLng.length && criteria.avoidOverlap) {
              let spurCheck = RPLoops.validateSpurBudget(candidate.latlngs, criteria.distanceKm);
              if (!spurCheck.ok && coordinates?._rpRelaxedOverlap) {
                const relaxedCheck = RPLoops.validateSpurBudget(candidate.latlngs, criteria.distanceKm, { relaxed: true });
                if (relaxedCheck.ok) {
                  spurCheck = relaxedCheck;
                  candidate._rpRelaxedOverlap = true;
                  candidate._rpFallbackOverlapM = relaxedCheck.extraM;
                  RPUtils.debugLog(`Boucle de secours acceptée : ${(relaxedCheck.extraM / 1000).toFixed(1)} km de chevauchement (aucune boucle plus propre trouvée).`, 'warn');
                }
              }
              if (!spurCheck.ok) {
                RPUtils.debugLog(`Boucle écartée avant découpe : ${spurCheck.reason}`, 'warn');
                if (attempt === finalAttempts) throw new Error(`${spurCheck.reason} Essaie un autre point ou une autre direction.`);
                continue;
              }
            }
            if (isLoopMode) {
              const cleaned = RPOverlaps.trimShortSpurs(candidate, { protectedPoints: waypointsLatLng });
              if (cleaned.cuts) RPUtils.debugLog(`${cleaned.cuts} petite(s) antenne(s) coupée(s) automatiquement (${Math.round(cleaned.removedM)} m).`, 'info');
            }
            const shapeCheck = isLoopMode
              ? RPLoops.validateLoopRoute(candidate.latlngs, startLatLng, criteria.loopDirection, criteria.avoidOverlap)
              : { ok: true };
            let check = shapeCheck.ok && waypointsLatLng.length
              ? RPLoops.validateUserWaypoints(candidate.latlngs, waypointsLatLng)
              : shapeCheck;
            if (check.ok && isLoopMode && waypointsLatLng.length && criteria.avoidOverlap) {
              check = RPLoops.validateSpurBudget(candidate.latlngs, criteria.distanceKm,
                { relaxed: Boolean(candidate._rpRelaxedOverlap) });
            }
            if (check.ok && isLoopMode && waypointsLatLng.length) {
              const actualKm = candidate.distance / 1000;
              const tolerance = Math.max(0.05, criteria.toleranceRatio || 0.1);
              const relativeError = Math.abs(actualKm / criteria.distanceKm - 1);
              if (relativeError > tolerance) {
                // Conserve un résultat raisonnablement proche : si un appel
                // suivant tombe en erreur, on ne perd pas ce tracé déjà obtenu.
                if (relativeError <= 0.20 && (!bestRoutedFallback || relativeError < bestRoutedFallback.relativeError)) {
                  bestRoutedFallback = { candidate, relativeError };
                  RPUtils.debugLog(`Candidat routé de secours mémorisé : ${actualKm.toFixed(1)} km (${Math.round(relativeError * 100)} % d'écart).`, 'warn');
                }
                check = { ok: false, reason: `Boucle de ${actualKm.toFixed(1)} km pour ${criteria.distanceKm} km demandés.` };
                // Correction volontairement amortie. L'ancienne formule
                // corrigeait 37,4 km vers une cible interne de 54,1 km pour
                // une demande de 45 km, ce qui provoquait une oscillation.
                const factor = (criteria.distanceKm / Math.max(1, actualKm)) ** 0.55;
                correctedDistanceKm = Math.max(criteria.distanceKm * 0.78,
                  Math.min(criteria.distanceKm * 1.30, correctedDistanceKm * factor));
                RPUtils.debugLog(`Nouvelle cible interne amortie : ${correctedDistanceKm.toFixed(1)} km.`, 'info');
              }
            }
            if (check.ok) { stats = candidate; break; }
            RPUtils.debugLog(`Résultat routé refusé (essai ${attempt}/${finalAttempts}) : ${check.reason}`, 'warn');
            if (attempt === finalAttempts) {
              if (bestRoutedFallback) {
                stats = bestRoutedFallback.candidate;
                RPUtils.debugLog(`Aucun résultat dans la tolérance stricte : meilleur tracé routé conservé (${(stats.distance / 1000).toFixed(1)} km).`, 'warn');
                break;
              }
              throw new Error(isLoopMode ? `${check.reason} Essaie une autre direction ou adapte la distance.` : check.reason);
            }
          }
          if (generationCancelled || !stats) break;
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
            boundaryPoints: labelBoundaryPoints,
            trimmable: isLoopMode,
            overlapSegments: isLoopMode ? RPOverlaps.findSegments(stats.latlngs) : [],
            overlapWarningM: stats._rpRelaxedOverlap ? stats._rpFallbackOverlapM : 0,
            criteria,
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
      drawOverlapHighlights();
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

  let overlapHighlightLayer = null;

  function clearOverlapHighlights() {
    if (overlapHighlightLayer) {
      RPMap.getMap().removeLayer(overlapHighlightLayer);
      overlapHighlightLayer = null;
    }
  }

  function drawOverlapHighlights() {
    clearOverlapHighlights();
    const map = RPMap.getMap();
    overlapHighlightLayer = L.featureGroup().addTo(map);
    for (const result of state.results) {
      if (!result.trimmable || !result.visible) continue;
      for (const [index, segment] of result.overlapSegments.entries()) {
        const piece = result.stats.latlngs.slice(segment.startIndex, segment.endIndex + 1);
        if (piece.length < 2) continue;
        const onTap = (event) => {
          L.DomEvent.stopPropagation(event);
          const content = document.createElement('div');
          const label = document.createElement('p');
          label.textContent = `Aller-retour superflu : environ ${(segment.removedDistanceM / 1000).toFixed(1)} km à retirer.`;
          content.appendChild(label);
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'route-trim-map-btn';
          button.textContent = '✂️ Tronquer cette portion';
          button.addEventListener('click', () => {
            trimOverlap(result.def.id, index);
            map.closePopup();
          });
          content.appendChild(button);
          L.popup({ minWidth: 205 }).setLatLng(event.latlng).setContent(content).openOn(map);
        };
        L.polyline(piece, { color: '#9c36ef', weight: 6, opacity: 0.82, dashArray: '3,9' })
          .on('click', onTap).addTo(overlapHighlightLayer);
        L.polyline(piece, { color: '#9c36ef', weight: 28, opacity: 0 })
          .on('click', onTap).addTo(overlapHighlightLayer);
      }
    }
  }

  function trimOverlap(routeId, index) {
    const result = state.results.find((r) => r.def.id === routeId);
    if (!result?.trimmable) return;
    const segment = result.overlapSegments[index];
    if (!segment) return;
    try {
      const removed = RPOverlaps.trimStats(result.stats, segment);
      result.overlapSegments = RPOverlaps.findSegments(result.stats.latlngs);
      result.quality = RPRouting.estimateQuality(result.stats, result.criteria, result.def.id);
      RPMap.drawRoute(routeId, result.stats.latlngs, result.def.colorHex, {
        avgSpeedKmh: result.avgSpeedKmh,
        boundaryPoints: result.boundaryPoints,
        routeIndex: state.results.indexOf(result),
        visible: result.visible,
      });
      renderResultsPanel();
      drawOverlapHighlights();
      RPUtils.toast(`Portion coupée : environ ${(removed / 1000).toFixed(1)} km en moins. Les exports utilisent le parcours modifié.`);
    } catch (error) {
      RPUtils.toast(error.message, { error: true });
    }
  }

  function renderResultsPanel() {
    RPUi.renderResults(state.results, {
      onToggleVisibility: (routeId) => {
        const result = state.results.find((r) => r.def.id === routeId);
        if (!result) return;
        result.visible = !result.visible;
        RPMap.setRouteVisibility(routeId, result.visible);
        renderResultsPanel();
        drawOverlapHighlights();
      },
      onTrim: trimOverlap,
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
