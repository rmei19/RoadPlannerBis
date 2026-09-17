/**
 * ui.js
 * Gère toute l'interaction du panneau : glissement tactile (façon Google
 * Maps) avec plusieurs positions d'ancrage, navigation par onglets,
 * synchronisation des champs de critères, rendu des cartes de résultats.
 * La logique métier (recherche, routing, export) reste dans les modules dédiés ;
 * ui.js ne fait que réagir aux événements et mettre à jour le DOM.
 */

const RPUi = (() => {

  const PANEL_STATES = ['collapsed', 'half', 'full'];
  let currentState = 'half';

  /* ======================================================================
     Panneau coulissant (drag tactile)
     ====================================================================== */

  function initPanelDrag() {
    const panel = document.getElementById('panel');
    const handle = document.getElementById('panel-handle');
    if (!panel || !handle) return;

    let startY = 0;
    let startTop = 0;
    let dragging = false;
    const vh = () => window.innerHeight;
    const safeTopPx = () => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--safe-top');
      return parseFloat(raw) || 0;
    };

    const stateTop = (state) => {
      const map = {
        collapsed: vh() - 68,
        half: vh() * 0.52,
        full: Math.max(64, safeTopPx() + 64),
      };
      return map[state];
    };

    function onPointerDown(e) {
      // Seul le bandeau supérieur (poignée + onglets) déclenche le drag,
      // pour laisser le scroll interne fonctionner normalement.
      dragging = true;
      startY = (e.touches ? e.touches[0].clientY : e.clientY);
      startTop = panel.getBoundingClientRect().top;
      panel.classList.add('is-dragging');
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('touchmove', onPointerMove, { passive: false });
      window.addEventListener('touchend', onPointerUp);
    }

    function onPointerMove(e) {
      if (!dragging) return;
      if (e.cancelable) e.preventDefault();
      const clientY = (e.touches ? e.touches[0].clientY : e.clientY);
      const delta = clientY - startY;
      let newTop = startTop + delta;
      newTop = Math.max(stateTop('full'), Math.min(stateTop('collapsed'), newTop));
      panel.style.top = `${newTop}px`;
      panel.style.transition = 'none';
    }

    function onPointerUp(e) {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('is-dragging');
      panel.style.transition = '';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('touchmove', onPointerMove);
      window.removeEventListener('touchend', onPointerUp);

      const currentTop = panel.getBoundingClientRect().top;
      // Snap vers l'état d'ancrage le plus proche
      let closest = PANEL_STATES[0];
      let minDist = Infinity;
      PANEL_STATES.forEach((state) => {
        const dist = Math.abs(currentTop - stateTop(state));
        if (dist < minDist) { minDist = dist; closest = state; }
      });
      panel.style.top = '';
      setPanelState(closest);
    }

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('touchstart', onPointerDown, { passive: true });

    // Un simple tap sur la poignée bascule half <-> full
    handle.addEventListener('click', () => {
      setPanelState(currentState === 'full' ? 'half' : 'full');
    });
  }

  function setPanelState(state) {
    currentState = state;
    document.getElementById('panel').dataset.state = state;
  }

  /* ======================================================================
     Onglets
     ====================================================================== */

  function initTabs() { /* Les sections partagent désormais un seul panneau. */ }

  function switchTab(tabId) {
    const target = document.getElementById(`tab-${tabId}`);
    if (!target) return;
    if (tabId === 'criteria') document.getElementById('criteria-details').open = true;
    if (currentState === 'collapsed') setPanelState('half');
    requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  /* ======================================================================
     Champs de critères (sliders avec valeur affichée, chips, modes)
     ====================================================================== */

  /** Formate une durée en heures (float) en "15 min", "1 h", "1 h 30"... */
  function formatCityDuration(hoursStr) {
    const totalMinutes = Math.round(parseFloat(hoursStr) * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (h === 0) return `${m} min`;
    if (m === 0) return `${h} h`;
    return `${h} h ${String(m).padStart(2, '0')}`;
  }

  function initCriteriaFields() {
    const bindings = [
      ['range-distance', 'val-distance', (v) => v],
      ['range-elevation', 'val-elevation', (v) => v],
      ['range-major-roads', 'val-major-roads', (v) => v],
      ['range-lights', 'val-lights', (v) => v],
      ['range-speed', 'val-speed', (v) => v],
      ['range-city-duration', 'val-city-duration', formatCityDuration],
    ];
    bindings.forEach(([inputId, labelId, transform]) => {
      const input = document.getElementById(inputId);
      const label = document.getElementById(labelId);
      if (!input || !label) return;
      input.addEventListener('input', () => { label.textContent = transform(input.value); });
    });

    document.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => chip.classList.toggle('is-active'));
    });

    // Persistance de la clé API ORS en localStorage
    const keyInput = document.getElementById('input-ors-key');
    const savedKey = RPUtils.storage.get('rp_ors_key', '') || RPRouting.getApiKey();
    if (savedKey) keyInput.value = savedKey;
    keyInput.addEventListener('change', () => RPUtils.storage.set('rp_ors_key', keyInput.value.trim()));

    document.getElementById('btn-toggle-key').addEventListener('click', (e) => {
      const isPassword = keyInput.type === 'password';
      keyInput.type = isPassword ? 'text' : 'password';
      e.currentTarget.classList.toggle('is-active', isPassword);
    });
  }

  function initModeGrid(onModeChange) {
    const grid = document.getElementById('mode-grid');
    grid.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        applyModeVisibility(btn.dataset.mode);
        onModeChange(btn.dataset.mode);
      });
    });
  }

  /** Sélecteur visuel du type de vélo : synchronise le <select> caché lu par profiles.js. */
  function initBikeTypeGrid() {
    const grid = document.getElementById('bike-type-grid');
    const hiddenSelect = document.getElementById('select-bike-type');
    grid.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        hiddenSelect.value = btn.dataset.bikeType;
      });
    });
  }

  /** Affiche/masque les champs Arrivée / Points de passage selon le mode choisi. */
  function applyModeVisibility(mode) {
    const endGroup = document.getElementById('end-field-group');
    const waypointsGroup = document.getElementById('waypoints-container');
    const detourGroup = document.getElementById('detour-field-group');
    const cityTourGroup = document.getElementById('city-tour-field-group');
    const routeCountGroup = document.getElementById('route-count-field-group');
    document.getElementById('loop-direction-group').hidden = mode !== 'loop' && mode !== 'random-loop';
    switch (mode) {
      case 'point-to-point':
        endGroup.style.display = '';
        waypointsGroup.style.display = '';
        detourGroup.style.display = '';
        cityTourGroup.style.display = 'none';
        routeCountGroup.style.display = '';
        break;
      case 'out-and-back':
        endGroup.style.display = '';
        waypointsGroup.style.display = '';
        detourGroup.style.display = 'none';
        cityTourGroup.style.display = 'none';
        routeCountGroup.style.display = '';
        break;
      case 'loop':
      case 'random-loop':
        endGroup.style.display = 'none';
        waypointsGroup.style.display = 'none';
        detourGroup.style.display = 'none';
        cityTourGroup.style.display = 'none';
        routeCountGroup.style.display = '';
        break;
      case 'loop-waypoints':
        endGroup.style.display = 'none';
        waypointsGroup.style.display = '';
        detourGroup.style.display = 'none';
        cityTourGroup.style.display = 'none';
        routeCountGroup.style.display = '';
        break;
      case 'city-tour':
        endGroup.style.display = 'none';
        waypointsGroup.style.display = 'none';
        detourGroup.style.display = 'none';
        cityTourGroup.style.display = '';
        routeCountGroup.style.display = 'none'; // toujours 1 seul itinéraire pour ce mode
        break;
      default:
        break;
    }

    // Le sélecteur "quel itinéraire ?" ne doit apparaître que si le groupe
    // "nombre de parcours" est visible ET que l'utilisateur a choisi 1 seul
    // itinéraire (relit la valeur réelle du select plutôt que de dupliquer
    // cette logique dans chaque branche ci-dessus).
    const singleTypeGroup = document.getElementById('single-route-type-field-group');
    const routeCountSelect = document.getElementById('select-route-count');
    const showSingleType = routeCountGroup.style.display !== 'none' && routeCountSelect.value === '1';
    singleTypeGroup.style.display = showSingleType ? '' : 'none';
  }

  /** Sélecteur visuel du mode de déplacement pour la visite citadine (à pied / à vélo). */
  function initCityTourTransportGrid() {
    const grid = document.getElementById('city-tour-transport-grid');
    const hiddenSelect = document.getElementById('select-city-transport');
    grid.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        hiddenSelect.value = btn.dataset.transport;
      });
    });
  }

  function getActiveMode() {
    return document.querySelector('.mode-btn.is-active')?.dataset.mode || 'point-to-point';
  }

  /* ======================================================================
     Liste des points de passage
     ====================================================================== */

  function renderWaypointsList(waypoints, onRemove, onMove, onInsert) {
    const list = document.getElementById('waypoints-list');
    list.innerHTML = '';
    waypoints.forEach((wp, i) => {
      const li = document.createElement('li');
      li.className = 'waypoint-item';
      li.innerHTML = `
        <span class="wp-index">${i + 1}</span>
        <span class="wp-label">${escapeHtml(wp.label)}</span>
        <button type="button" class="wp-action" data-action="insert" aria-label="Insérer un point avant le point ${i + 1}" title="Insérer avant">+ avant</button>
        <button type="button" class="wp-action" data-action="up" aria-label="Monter le point ${i + 1}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="wp-action" data-action="down" aria-label="Descendre le point ${i + 1}" ${i === waypoints.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="wp-remove" aria-label="Retirer ce point">✕</button>`;
      li.querySelector('.wp-remove').addEventListener('click', () => onRemove(i));
      li.querySelector('[data-action=up]').addEventListener('click', () => onMove(i, i - 1));
      li.querySelector('[data-action=down]').addEventListener('click', () => onMove(i, i + 1));
      li.querySelector('[data-action=insert]').addEventListener('click', () => onInsert(i));
      list.appendChild(li);
    });
  }

  /* ======================================================================
     Cartes de résultats
     ====================================================================== */

  function renderResults(routeResults, { onToggleVisibility, onExport, onTrim }) {
    const emptyEl = document.getElementById('results-empty');
    const listEl = document.getElementById('results-list');
    listEl.innerHTML = '';

    if (!routeResults.length) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    routeResults.forEach((result) => {
      const { def, stats, quality, visible, avgSpeedKmh, pois } = result;
      const spurSegments = result.overlapSegments || [];
      const durationSeconds = (stats.distance / 1000 / avgSpeedKmh) * 3600;
      const engineLabel = stats.engine === 'brouter' ? 'via BRouter' : 'via OpenRouteService';
      const poisListHtml = pois && pois.length
        ? `<div class="route-poi-list">
            <div class="route-poi-list-title">Lieux visités, dans l'ordre</div>
            <ol>${pois.map((p) => `<li>${escapeHtml(p.name)} <span class="route-poi-category">${escapeHtml(p.categoryLabel || '')}</span></li>`).join('')}</ol>
          </div>`
        : '';

      const card = document.createElement('div');
      card.className = 'route-card';
      card.style.setProperty('--route-color', def.colorHex);

      card.innerHTML = `
        <div class="route-card-header">
          <div class="route-card-title">
            <span class="route-swatch"></span>
            <span class="route-name">${def.name}</span>
            <span class="route-engine-badge">${engineLabel}</span>
          </div>
          <button class="route-visibility-toggle ${visible ? 'is-visible' : ''}" data-action="toggle">
            ${visible ? 'Affiché' : 'Masqué'}
          </button>
        </div>

        <div class="route-stats-grid">
          <div class="stat-block">
            <div class="stat-value">${RPUtils.formatDistance(stats.distance)}</div>
            <div class="stat-label">Distance</div>
          </div>
          <div class="stat-block">
            <div class="stat-value">${RPUtils.formatDuration(durationSeconds)}</div>
            <div class="stat-label">Temps estimé</div>
          </div>
          <div class="stat-block">
            <div class="stat-value">${RPUtils.formatElevation(stats.ascent)}<small>D+</small></div>
            <div class="stat-label">Dénivelé positif</div>
          </div>
          <div class="stat-block">
            <div class="stat-value">${RPUtils.formatElevation(stats.descent)}<small>D-</small></div>
            <div class="stat-label">Dénivelé négatif</div>
          </div>
          <div class="stat-block">
            <div class="stat-value">${Math.round(avgSpeedKmh)}<small>km/h</small></div>
            <div class="stat-label">Vitesse moyenne</div>
          </div>
          <div class="stat-block">
            <div class="stat-value">${stats.majorRoadCrossings == null ? 'N/D' : stats.majorRoadCrossings}</div>
            <div class="stat-label">Grandes routes</div>
          </div>
        </div>

        ${buildElevationProfileSvg(stats, def.colorHex)}
        ${spurSegments.length ? `<div class="route-overlap-note">✂️ ${spurSegments.length} branche${spurSegments.length > 1 ? 's' : ''} parcourue${spurSegments.length > 1 ? 's' : ''} deux fois. Touche les tirets violets sur la carte ou coupe ici :
          ${spurSegments.map((seg, i) => `<button type="button" class="route-trim-btn" data-segment="${i}">Couper ~${(seg.removedDistanceM / 1000).toFixed(1)} km</button>`).join('')}</div>` : ''}
        ${poisListHtml}

        <div class="route-actions">
          <button class="btn-export" data-format="gpx">GPX</button>
          <button class="btn-export" data-format="tcx">TCX</button>
          <button class="btn-export" data-format="fit">FIT</button>
        </div>
      `;

      card.querySelector('[data-action="toggle"]').addEventListener('click', () => onToggleVisibility(def.id));
      card.querySelectorAll('.route-trim-btn').forEach((btn) => {
        btn.addEventListener('click', () => onTrim(def.id, Number(btn.dataset.segment)));
      });
      card.querySelectorAll('.btn-export').forEach((btn) => {
        btn.addEventListener('click', () => onExport(def.id, btn.dataset.format));
      });

      listEl.appendChild(card);
    });
  }

  /**
   * Construit un mini profil d'altitude en SVG inline (aucune dépendance
   * externe) à partir des coordonnées brutes du parcours (z = altitude,
   * fournie par ORS et BRouter quand elevation est demandé). Si l'altitude
   * est indisponible, affiche un message plutôt qu'un graphique vide.
   */
  function buildElevationProfileSvg(stats, colorHex) {
    const coords = stats.raw?.geometry?.coordinates;
    if (!coords || !coords.length || coords[0].length < 3) {
      return '<div class="elevation-profile elevation-profile-empty">Profil altimétrique indisponible</div>';
    }

    // Distance cumulée + altitude à chaque point, puis sous-échantillonnage
    // pour un tracé SVG léger (~80 points suffisent visuellement).
    const raw = coords.map((c, i) => {
      const prev = i > 0 ? coords[i - 1] : c;
      return { ele: c[2] || 0, lat: c[1], lng: c[0], prevLat: prev[1], prevLng: prev[0] };
    });
    let cum = 0;
    const points = raw.map((p, i) => {
      if (i > 0) cum += RPUtils.haversineDistance([p.prevLat, p.prevLng], [p.lat, p.lng]);
      return { dist: cum, ele: p.ele };
    });

    const maxPoints = 80;
    const stride = Math.max(1, Math.floor(points.length / maxPoints));
    const sampled = points.filter((_, i) => i % stride === 0 || i === points.length - 1);

    const elevations = sampled.map((p) => p.ele);
    const minEle = Math.min(...elevations);
    const maxEle = Math.max(...elevations);
    const eleRange = Math.max(1, maxEle - minEle);
    const totalDist = sampled[sampled.length - 1].dist || 1;

    const width = 280;
    const height = 56;
    const pad = 2;

    const pathPoints = sampled.map((p) => {
      const x = pad + (p.dist / totalDist) * (width - pad * 2);
      const y = height - pad - ((p.ele - minEle) / eleRange) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const linePath = `M${pathPoints.join(' L')}`;
    const areaPath = `${linePath} L${width - pad},${height - pad} L${pad},${height - pad} Z`;

    return `
      <div class="elevation-profile">
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="elevation-profile-svg">
          <path d="${areaPath}" fill="${colorHex}" opacity="0.18" stroke="none"></path>
          <path d="${linePath}" fill="none" stroke="${colorHex}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
        </svg>
        <div class="elevation-profile-labels">
          <span>${Math.round(minEle)} m</span>
          <span class="elevation-profile-labels-sep">—</span>
          <span>${Math.round(maxEle)} m</span>
        </div>
      </div>`;
  }

  function setLoading(isLoading, text = 'Calcul des parcours…', onCancel = null) {
    const overlay = document.getElementById('loading-overlay');
    const cancelBtn = document.getElementById('btn-cancel-loading');
    document.getElementById('loading-text').textContent = text;
    overlay.hidden = !isLoading;
    cancelBtn.onclick = null;
    if (isLoading && typeof onCancel === 'function') {
      cancelBtn.onclick = onCancel;
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return {
    initPanelDrag,
    setPanelState,
    initTabs,
    switchTab,
    initCriteriaFields,
    initModeGrid,
    initBikeTypeGrid,
    initCityTourTransportGrid,
    applyModeVisibility,
    getActiveMode,
    renderWaypointsList,
    renderResults,
    setLoading,
  };
})();
