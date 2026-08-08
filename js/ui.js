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
        collapsed: vh() - 108,
        half: vh() * 0.52,
        full: Math.max(56, safeTopPx() + 44),
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
      newTop = Math.max(stateTop('full'), Math.min(vh() - 96, newTop));
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

  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      const active = b.dataset.tab === tabId;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('is-active', p.id === `tab-${tabId}`);
    });
    // Ouvrir un peu le panneau si on consulte un onglet alors qu'il est replié
    if (currentState === 'collapsed') setPanelState('half');
  }

  /* ======================================================================
     Champs de critères (sliders avec valeur affichée, chips, modes)
     ====================================================================== */

  function initCriteriaFields() {
    const bindings = [
      ['range-distance', 'val-distance', (v) => v],
      ['range-tolerance', 'val-tolerance', (v) => v],
      ['range-elevation', 'val-elevation', (v) => v],
      ['range-major-roads', 'val-major-roads', (v) => v],
      ['range-lights', 'val-lights', (v) => v],
      ['range-speed', 'val-speed', (v) => v],
      ['range-city-radius', 'val-city-radius', (v) => v],
      ['range-city-stops', 'val-city-stops', (v) => v],
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

  function renderWaypointsList(waypoints, onRemove) {
    const list = document.getElementById('waypoints-list');
    list.innerHTML = '';
    waypoints.forEach((wp, i) => {
      const li = document.createElement('li');
      li.className = 'waypoint-item';
      li.innerHTML = `
        <span class="wp-index">${i + 1}</span>
        <span class="wp-label">${escapeHtml(wp.label)}</span>
        <button class="wp-remove" aria-label="Retirer ce point">✕</button>`;
      li.querySelector('.wp-remove').addEventListener('click', () => onRemove(i));
      list.appendChild(li);
    });
  }

  /* ======================================================================
     Cartes de résultats
     ====================================================================== */

  function renderResults(routeResults, { onToggleVisibility, onExport }) {
    const emptyEl = document.getElementById('results-empty');
    const listEl = document.getElementById('results-list');
    listEl.innerHTML = '';

    if (!routeResults.length) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    routeResults.forEach((result) => {
      const { def, stats, quality, visible, avgSpeedKmh } = result;
      const durationSeconds = (stats.distance / 1000 / avgSpeedKmh) * 3600;
      const engineLabel = stats.engine === 'brouter' ? 'via BRouter' : 'via OpenRouteService';

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

        <div class="route-actions">
          <button class="btn-export" data-format="gpx">GPX</button>
          <button class="btn-export" data-format="tcx">TCX</button>
          <button class="btn-export" data-format="fit">FIT</button>
        </div>
      `;

      card.querySelector('[data-action="toggle"]').addEventListener('click', () => onToggleVisibility(def.id));
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
