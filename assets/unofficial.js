'use strict';

(() => {
  let attempts = 0;
  const maxAttempts = 60;

  const escapeHtmlLocal = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  function fmt(value, suffix = '', digits = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return `${number.toFixed(digits)}${suffix}`;
  }

  function renderUnofficial() {
    attempts += 1;
    const target = document.getElementById('unofficialStationContent');
    if (!target) return;

    if (typeof DATA === 'undefined' || !DATA || typeof CONFIG === 'undefined' || !CONFIG) {
      if (attempts < maxAttempts) window.setTimeout(renderUnofficial, 250);
      return;
    }

    const status = DATA.unofficial_status || {};
    const rows = Array.isArray(DATA.unofficial_stations) ? DATA.unofficial_stations : [];

    if (!rows.length) {
      const note = status.note || 'No live unofficial personal-station observations are connected.';
      target.innerHTML = `<div class="panel"><div class="no-data"><strong>No live unofficial readings available.</strong><br>${escapeHtmlLocal(note)}</div></div>`;
      return;
    }

    target.innerHTML = `
      <div class="table-wrap panel" style="margin:0">
        <table>
          <caption>Latest unofficial personal weather station observations</caption>
          <thead>
            <tr>
              <th scope="col">Station</th>
              <th scope="col">Observed</th>
              <th scope="col">Temp.</th>
              <th scope="col">Feels like</th>
              <th scope="col">Humidity</th>
              <th scope="col">Wind</th>
              <th scope="col">Gust</th>
              <th scope="col">Rain rate</th>
              <th scope="col">Freshness</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((station) => {
              const freshness = station.stale
                ? '<span class="stale">Stale</span>'
                : '<span class="fresh">Current</span>';
              const observed = typeof formatDateTime === 'function'
                ? formatDateTime(station.observed_at)
                : (station.observed_at || 'Unavailable');
              const feels = station.heat_index_f ?? station.wind_chill_f ?? station.temperature_f;
              return `<tr>
                <th scope="row">${escapeHtmlLocal(station.name || station.id || 'Personal station')}<br><span class="fine-print">${escapeHtmlLocal(station.id || '')} · Unofficial PWS</span></th>
                <td>${escapeHtmlLocal(observed)}</td>
                <td>${fmt(station.temperature_f, '°F')}</td>
                <td>${fmt(feels, '°F')}</td>
                <td>${fmt(station.relative_humidity_pct, '%')}</td>
                <td>${fmt(station.wind_speed_mph, ' mph')} ${Number.isFinite(Number(station.wind_direction_deg)) ? `/ ${Math.round(Number(station.wind_direction_deg))}°` : ''}</td>
                <td>${fmt(station.wind_gust_mph, ' mph')}</td>
                <td>${fmt(station.precip_rate_in_per_hr, ' in/hr', 2)}</td>
                <td>${freshness}<br><span class="fine-print">${Number.isFinite(Number(station.age_minutes)) ? `${Math.round(Number(station.age_minutes))} min old` : 'Unknown age'}</span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <p class="fine-print" style="margin:.65rem 0 0">Unofficial personal weather station readings are supplemental only. They are not quality-controlled official observations and are not used in the dashboard decision calculation.</p>`;
  }

  window.addEventListener('load', () => window.setTimeout(renderUnofficial, 350));
})();