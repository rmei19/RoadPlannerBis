/**
 * weather.js
 * Prévisions météo légères via Open-Meteo (API publique gratuite, sans clé),
 * utilisées pour informer le cycliste des conditions au départ de sa sortie
 * (vent, température, risque de pluie) — utile pour choisir le bon sens de
 * boucle ou le bon jour de sortie.
 */

const RPWeather = (() => {

  const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

  const WEATHER_CODE_LABELS = {
    0: 'Ciel dégagé', 1: 'Peu nuageux', 2: 'Partiellement nuageux', 3: 'Couvert',
    45: 'Brouillard', 48: 'Brouillard givrant',
    51: 'Bruine légère', 53: 'Bruine', 55: 'Bruine forte',
    61: 'Pluie légère', 63: 'Pluie', 65: 'Pluie forte',
    71: 'Neige légère', 73: 'Neige', 75: 'Neige forte',
    80: 'Averses', 81: 'Averses fortes', 82: 'Averses violentes',
    95: 'Orage', 96: 'Orage avec grêle',
  };

  /** Récupère les conditions actuelles + vent au point [lat,lng]. */
  async function fetchCurrentConditions([lat, lng]) {
    const params = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lng.toFixed(4),
      current: 'temperature_2m,wind_speed_10m,wind_direction_10m,weather_code',
      wind_speed_unit: 'kmh',
      timezone: 'auto',
    });
    try {
      const res = await fetch(`${OPEN_METEO_URL}?${params.toString()}`);
      if (!res.ok) throw new Error(`Open-Meteo a répondu ${res.status}`);
      const data = await res.json();
      const c = data.current;
      return {
        temperatureC: c.temperature_2m,
        windKmh: c.wind_speed_10m,
        windDirectionDeg: c.wind_direction_10m,
        label: WEATHER_CODE_LABELS[c.weather_code] || 'Conditions inconnues',
      };
    } catch (err) {
      console.warn('Erreur météo Open-Meteo', err);
      return null;
    }
  }

  /** Détermine si le vent est globalement favorable, défavorable ou de travers pour un cap de parcours donné. */
  function windRelativeToBearing(windDirectionDeg, routeBearingDeg) {
    // windDirectionDeg = direction D'OU vient le vent (convention météo)
    const diff = Math.abs(((routeBearingDeg - windDirectionDeg + 540) % 360) - 180);
    if (diff < 45) return 'face'; // vent de face
    if (diff > 135) return 'dos'; // vent dans le dos
    return 'travers';
  }

  return { fetchCurrentConditions, windRelativeToBearing };
})();
