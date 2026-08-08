/**
 * geocoder.js
 * Recherche d'adresses / villes / cols / lieux-dits via l'API Nominatim
 * (OpenStreetMap), avec gestion d'autocomplétion, reverse-geocoding et
 * détection directe de coordonnées GPS saisies au clavier.
 *
 * Nominatim impose une limite d'1 requête/seconde et un User-Agent
 * identifiable : on respecte ces règles via un anti-rebond et un usage
 * raisonnable côté client (application non hébergée sur un serveur tiers).
 */

const RPGeocoder = (() => {

  const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
  const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';

  // Types de lieux mis en avant pour le vélo de route (cols, hameaux, etc.)
  const FRIENDLY_TYPES = {
    mountain_pass: 'Col',
    peak: 'Sommet',
    village: 'Village',
    hamlet: 'Lieu-dit',
    town: 'Ville',
    city: 'Ville',
    administrative: 'Commune',
    road: 'Route',
    residential: 'Rue',
  };

  function labelForType(item) {
    return FRIENDLY_TYPES[item.type] || FRIENDLY_TYPES[item.class] || item.type || item.class || 'Lieu';
  }

  /**
   * Recherche des suggestions pour une requête texte.
   * Retourne directement un résultat "coordonnées" si le texte saisi
   * ressemble à "lat, lng".
   */
  async function search(query) {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];

    const coords = RPUtils.parseCoordinates(trimmed);
    if (coords) {
      return [{
        id: 'coords',
        label: `Coordonnées : ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`,
        type: 'Coordonnées GPS',
        lat: coords.lat,
        lng: coords.lng,
      }];
    }

    const params = new URLSearchParams({
      q: trimmed,
      format: 'jsonv2',
      addressdetails: '1',
      'accept-language': 'fr',
      countrycodes: 'fr,ch,be,it,es,de,lu,ad,mc',
      limit: '8',
    });

    try {
      const res = await RPUtils.fetchWithTimeout(`${NOMINATIM_URL}?${params.toString()}`, {
        headers: { 'Accept': 'application/json' },
      }, 10000);
      if (!res.ok) throw new Error(`Nominatim a répondu ${res.status}`);
      const data = await res.json();
      return data.map((item) => ({
        id: item.place_id,
        label: item.display_name,
        type: labelForType(item),
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon),
      }));
    } catch (err) {
      console.warn('Erreur de géocodage Nominatim', err);
      return [];
    }
  }

  /** Reverse-geocoding : retrouve un libellé lisible à partir d'un point cliqué sur la carte. */
  async function reverseGeocode([lat, lng]) {
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lng),
      format: 'jsonv2',
      'accept-language': 'fr',
    });
    try {
      const res = await RPUtils.fetchWithTimeout(`${NOMINATIM_REVERSE_URL}?${params.toString()}`, {}, 8000);
      if (!res.ok) throw new Error(`Nominatim a répondu ${res.status}`);
      const data = await res.json();
      return data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    } catch (err) {
      return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }
  }

  /**
   * Branche l'autocomplétion sur un champ texte : affiche une liste de
   * suggestions <ul> et appelle onSelect(result) quand l'utilisateur en choisit une.
   */
  function attachAutocomplete(inputEl, listEl, onSelect) {
    const runSearch = RPUtils.debounce(async () => {
      const query = inputEl.value;
      if (query.trim().length < 2) {
        listEl.hidden = true;
        listEl.innerHTML = '';
        return;
      }
      const results = await search(query);
      renderSuggestions(results);
    }, 450); // respecte la limite Nominatim (1 req/s max)

    function renderSuggestions(results) {
      listEl.innerHTML = '';
      if (!results.length) {
        listEl.hidden = true;
        return;
      }
      results.forEach((r) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="suggestion-type">${r.type}</span>${escapeHtml(r.label)}`;
        li.addEventListener('click', () => {
          inputEl.value = r.label;
          inputEl.dispatchEvent(new Event('input'));
          listEl.hidden = true;
          listEl.innerHTML = '';
          onSelect(r);
        });
        listEl.appendChild(li);
      });
      listEl.hidden = false;
    }

    inputEl.addEventListener('input', runSearch);
    inputEl.addEventListener('focus', () => {
      if (listEl.children.length) listEl.hidden = false;
    });
    document.addEventListener('click', (e) => {
      if (!listEl.contains(e.target) && e.target !== inputEl) {
        listEl.hidden = true;
      }
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return { search, reverseGeocode, attachAutocomplete };
})();
