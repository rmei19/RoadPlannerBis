/**
 * utils.js
 * Fonctions utilitaires partagées par tous les modules : formatage,
 * anti-rebond (debounce), stockage local, calculs géométriques simples.
 * Aucune dépendance externe.
 */

const RPUtils = (() => {

  /** Anti-rebond générique : retarde l'exécution de fn tant que appelée à nouveau. */
  function debounce(fn, delay = 300) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  /** Formate une distance en mètres vers un texte "12,4 km" ou "850 m". */
  function formatDistance(meters) {
    if (meters == null || isNaN(meters)) return '—';
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`;
  }

  /** Formate une durée en secondes vers "2 h 35". */
  function formatDuration(seconds) {
    if (seconds == null || isNaN(seconds)) return '—';
    const totalMin = Math.round(seconds / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return `${m} min`;
    return `${h} h ${String(m).padStart(2, '0')}`;
  }

  /** Formate un dénivelé en mètres avec signe. */
  function formatElevation(meters) {
    if (meters == null || isNaN(meters)) return '—';
    return `${Math.round(meters)} m`;
  }

  /** Formate un pourcentage arrondi. */
  function formatPercent(ratio) {
    if (ratio == null || isNaN(ratio)) return '0 %';
    return `${Math.round(ratio * 100)} %`;
  }

  /** Distance orthodromique (Haversine) en mètres entre deux [lat,lng]. */
  function haversineDistance([lat1, lon1], [lat2, lon2]) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /** Déplace un point [lat,lng] d'une distance (m) selon un cap (degrés, 0=Nord). */
  function destinationPoint([lat, lng], distanceMeters, bearingDeg) {
    const R = 6371000;
    const brng = (bearingDeg * Math.PI) / 180;
    const lat1 = (lat * Math.PI) / 180;
    const lon1 = (lng * Math.PI) / 180;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(distanceMeters / R) +
        Math.cos(lat1) * Math.sin(distanceMeters / R) * Math.cos(brng)
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brng) * Math.sin(distanceMeters / R) * Math.cos(lat1),
        Math.cos(distanceMeters / R) - Math.sin(lat1) * Math.sin(lat2)
      );
    return [(lat2 * 180) / Math.PI, (((lon2 * 180) / Math.PI + 540) % 360) - 180];
  }

  /** Cap initial (en degrés, 0=Nord) du grand cercle allant du point A vers le point B. */
  function bearingBetween([lat1, lon1], [lat2, lon2]) {
    const toRad = (d) => (d * Math.PI) / 180;
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δλ = toRad(lon2 - lon1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  /** Génère un identifiant court unique (pas cryptographique, suffisant pour l'UI). */
  function uid(prefix = 'id') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Lecture/écriture simplifiée du localStorage avec JSON automatique. */
  const storage = {
    get(key, fallback = null) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (err) {
        console.warn('RPUtils.storage.set a échoué', err);
      }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch {}
    },
  };

  /** Affiche une notification toast en bas de l'écran. */
  function toast(message, { error = false, duration = 3200 } = {}) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast' + (error ? ' is-error' : '');
    el.textContent = message;
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));
    setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => el.remove(), 250);
    }, duration);
  }

  /**
   * Journal de diagnostic visible directement à l'écran (panneau en bas de
   * page), en plus de la console. Utile quand l'utilisateur ne peut pas
   * ouvrir les devtools (ex. capture d'écran à distance, pas de clavier/souris
   * disponible). level : 'info' | 'ok' | 'warn' | 'error'.
   */
  function debugLog(message, level = 'info', data = undefined) {
    const consoleFn = { error: console.error, warn: console.warn }[level] || console.log;
    if (data !== undefined) consoleFn(`[RoadPlanner] ${message}`, data);
    else consoleFn(`[RoadPlanner] ${message}`);

    const logEl = document.getElementById('debug-log');
    if (!logEl) return;
    const time = new Date().toLocaleTimeString('fr-FR', { hour12: false });
    const cssClass = { ok: 'log-ok', warn: 'log-warn', error: 'log-error' }[level] || '';
    const line = document.createElement('div');
    line.innerHTML = `<span class="log-time">${time}</span> ${escapeForLog(message)}` +
      (data !== undefined ? ` <span class="${cssClass}">${escapeForLog(safeStringify(data))}</span>` : '');
    if (cssClass && data === undefined) line.className = cssClass;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function safeStringify(data) {
    try {
      if (data instanceof Error) return data.message;
      return JSON.stringify(data);
    } catch {
      return String(data);
    }
  }

  function escapeForLog(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  /** Détecte si une chaîne ressemble à des coordonnées GPS "lat, lng". */
  function parseCoordinates(text) {
    const match = text.trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
    if (!match) return null;
    const lat = parseFloat(match[1]);
    const lng = parseFloat(match[2]);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }

  /**
   * fetch() avec délai maximal : évite tout blocage indéfini (réseau bridé,
   * serveur qui ne répond jamais). Centralisé ici pour être utilisé par
   * tous les modules faisant des appels réseau (geocoder, routing).
   */
  async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    debounce,
    formatDistance,
    formatDuration,
    formatElevation,
    formatPercent,
    haversineDistance,
    bearingBetween,
    destinationPoint,
    uid,
    storage,
    toast,
    debugLog,
    parseCoordinates,
    fetchWithTimeout,
  };
})();
